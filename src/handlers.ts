// HTTP handlers shared by the Vercel functions (api/*.ts) and the local dev server (src/server.ts).
// Everything here is reachable by anyone on the internet once deployed, so validate all input and
// never return internal error details (RPC URLs can embed API keys).
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { getPrices, searchTokens, type TokenMeta } from "./jupiter.js";
import { getHoldings } from "./wallet.js";
import { planSwaps } from "./plan.js";

const SOL = "So11111111111111111111111111111111111111112";
const MAX_TOKENS_PER_PLAN = 30; // each token costs a Jupiter /build call plus simulations
const MAX_TXS_PER_SEND = 10;
const MAX_TX_BYTES = 1232;

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

function env() {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) throw new Error("JUPITER_API_KEY is not set");
  const rpc = process.env.RPC_URL;
  // The public RPC rate-limits hard and blocks the token-account queries this app needs.
  if (!rpc && process.env.VERCEL) throw new Error("RPC_URL is not set");
  return { apiKey, connection: new Connection(rpc ?? "https://api.mainnet-beta.solana.com", "confirmed") };
}

// Best-effort per-IP limiter. Serverless instances don't share memory, so this only blunts bursts
// against one warm instance; the real limit is the Vercel WAF rule described in the README.
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(req: Request, bucket: string, perMinute: number) {
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.reset < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { n: 1, reset: now + 60_000 });
  } else if (++e.n > perMinute) {
    throw new HttpError(429, "Too many requests, slow down and try again in a minute.");
  }
}

function pubkey(v: unknown, what: string): PublicKey {
  try {
    if (typeof v !== "string" || v.length > 44) throw 0;
    return new PublicKey(v);
  } catch {
    throw new HttpError(400, `invalid ${what}`);
  }
}

async function readJson(req: Request): Promise<any> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "expected JSON");
  const text = await req.text();
  if (text.length > 200_000) throw new HttpError(413, "body too large");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function wrap(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    try {
      return Response.json(await fn(req), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      return Response.json({ error: "Something went wrong on the server. Please try again." }, { status: 500 });
    }
  };
}

async function metaFor(apiKey: string, mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  for (let i = 0; i < mints.length; i += 100) {
    for (const t of await searchTokens(apiKey, mints.slice(i, i + 100).join(","))) out.set(t.id, t);
  }
  return out;
}

async function holdingsWithValue(apiKey: string, connection: Connection, owner: PublicKey) {
  const holdings = (await getHoldings(connection, owner)).filter((h) => h.mint !== SOL);
  const mints = [...new Set(holdings.map((h) => h.mint))];
  const [prices, meta] = await Promise.all([getPrices(apiKey, mints), metaFor(apiKey, mints)]);
  return holdings.map((h) => {
    const price = prices[h.mint]?.usdPrice ?? null;
    const m = meta.get(h.mint);
    return {
      h,
      price,
      usd: price === null ? null : h.uiAmount * price,
      symbol: m?.symbol ?? null,
      name: m?.name ?? null,
      icon: m?.icon ?? null,
      verified: !!m?.isVerified,
    };
  });
}

export const holdings = wrap(async (req) => {
  rateLimit(req, "holdings", 20);
  const { apiKey, connection } = env();
  const owner = pubkey(new URL(req.url).searchParams.get("owner"), "owner");
  const rows = await holdingsWithValue(apiKey, connection, owner);
  return rows.map(({ h, ...r }) => ({ mint: h.mint, amount: h.uiAmount, frozen: h.frozen, ...r }));
});

export const tokenSearch = wrap(async (req) => {
  rateLimit(req, "search", 60);
  const { apiKey } = env();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q || q.length > 64) return [];
  const res = await searchTokens(apiKey, q);
  return res.slice(0, 20).map((t) => ({
    id: t.id,
    symbol: t.symbol,
    name: t.name,
    icon: t.icon ?? null,
    decimals: t.decimals,
    verified: !!t.isVerified,
  }));
});

export const plan = wrap(async (req) => {
  rateLimit(req, "plan", 10);
  const b = await readJson(req);
  const owner = pubkey(b.owner, "owner");
  const outMint = pubkey(b.outMint, "outMint").toBase58();
  if (!Array.isArray(b.mints) || b.mints.length === 0) throw new HttpError(400, "select at least one token");
  if (b.mints.length > MAX_TOKENS_PER_PLAN) throw new HttpError(400, `select at most ${MAX_TOKENS_PER_PLAN} tokens at a time`);
  const wanted = new Set<string>(b.mints.map((m: unknown) => pubkey(m, "mint").toBase58()));
  wanted.delete(outMint);
  const slippageBps = Math.min(Math.max(Math.round(Number(b.slippageBps) || 100), 1), 2000);
  const maxLossPct = Number(b.maxLossPct);
  const maxLoss = Math.min(Math.max(Number.isFinite(maxLossPct) ? maxLossPct : 10, 0), 50) / 100;
  const { apiKey, connection } = env();

  // Re-read balances and prices server-side; never trust amounts from the browser.
  const rows = await holdingsWithValue(apiKey, connection, owner);
  const outPrice = (await getPrices(apiKey, [outMint]))[outMint];
  if (!outPrice) throw new HttpError(400, "The token you're swapping into has no reliable price, so swaps can't be checked. Pick another.");

  const skipped: { mint: string; reason: string }[] = [];
  const items: { h: (typeof rows)[number]["h"]; usd: number }[] = [];
  for (const mint of wanted) {
    const r = rows.find((x) => x.h.mint === mint);
    if (!r) skipped.push({ mint, reason: "not in wallet" });
    else if (r.h.frozen) skipped.push({ mint, reason: "account frozen" });
    else if (r.usd === null) skipped.push({ mint, reason: "no reliable price" });
    else items.push({ h: r.h, usd: r.usd });
  }

  const result = await planSwaps({
    connection,
    apiKey,
    owner,
    outMint,
    outInfo: outPrice,
    items,
    slippageBps,
    maxAccounts: 20,
    maxLoss,
    closeSource: b.closeAccounts !== false,
  });
  // Jupiter/RPC error text can be noisy or leak details; keep reasons short and generic.
  skipped.push(...result.skipped.map((s) => ({ mint: s.mint, reason: s.reason.startsWith("no route") ? "no route found" : s.reason })));
  return {
    skipped,
    txs: result.batches.map((bt) => {
      const bytes = bt.tx.serialize();
      return {
        tx: Buffer.from(bytes).toString("base64"),
        bytes: bytes.length,
        legs: bt.legs.map((l) => ({
          mint: l.holding.mint,
          usdIn: l.usdIn,
          outAmount: Number(l.build.outAmount) / 10 ** outPrice.decimals,
        })),
      };
    }),
  };
});

export const send = wrap(async (req) => {
  rateLimit(req, "send", 10);
  const b = await readJson(req);
  if (!Array.isArray(b.txs) || b.txs.length === 0 || b.txs.length > MAX_TXS_PER_SEND) throw new HttpError(400, "bad transactions");
  // Only relay well-formed, fully signed transactions so this can't be used as a generic spam relay.
  const raws = b.txs.map((t: unknown) => {
    if (typeof t !== "string" || t.length > 2000) throw new HttpError(400, "bad transaction");
    const raw = Buffer.from(t, "base64");
    if (raw.length > MAX_TX_BYTES) throw new HttpError(400, "transaction too large");
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(raw);
    } catch {
      throw new HttpError(400, "bad transaction");
    }
    if (tx.signatures.some((s) => s.every((byte) => byte === 0))) throw new HttpError(400, "transaction is not signed");
    return raw;
  });
  const { connection } = env();
  const sigs: (string | { error: string })[] = [];
  for (const raw of raws) {
    try {
      sigs.push(await connection.sendRawTransaction(raw, { maxRetries: 3 }));
    } catch (e) {
      console.error(e);
      sigs.push({ error: /blockhash/i.test(String(e)) ? "expired, please preview again" : "rejected by the network (simulation failed)" });
    }
  }
  return sigs;
});

export const status = wrap(async (req) => {
  rateLimit(req, "status", 120);
  const sigs = (new URL(req.url).searchParams.get("sigs") ?? "").split(",").filter(Boolean);
  if (!sigs.length || sigs.length > MAX_TXS_PER_SEND) throw new HttpError(400, "bad signatures");
  for (const s of sigs) {
    let ok = false;
    try {
      ok = bs58.decode(s).length === 64;
    } catch {}
    if (!ok) throw new HttpError(400, "bad signature");
  }
  const { connection } = env();
  const { value } = await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true });
  return value.map((v) => (v ? { status: v.confirmationStatus, err: v.err } : null));
});
