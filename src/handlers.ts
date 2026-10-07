// HTTP handlers shared by the Vercel functions (api/*.ts) and the local dev server (src/server.ts).
// Everything here is reachable by anyone on the internet once deployed, so validate all input and
// never return internal error details (RPC URLs can embed API keys).
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { JUP_RPS, getPrices, jupStats, searchTokens, type PriceInfo, type TokenMeta } from "./jupiter.js";
import { getHoldings } from "./wallet.js";
import { feeApplies, planSwaps, type FeeConfig } from "./plan.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MAX_TOKENS_PER_PLAN = 30; // each token costs a Jupiter /build call plus simulations
const MAX_TXS_PER_SEND = 30; // one transaction per token, so this matches MAX_TOKENS_PER_PLAN
const MAX_TX_BYTES = 1232;

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

/** Buy-and-burn fee, configured by env. Off unless BURN_TOKEN_MINT is set. */
function feeConfig(): FeeConfig | null {
  const mint = process.env.BURN_TOKEN_MINT?.trim();
  if (!mint) return null;
  const bps = Number(process.env.FEE_BPS ?? 100);
  if (!Number.isInteger(bps) || bps < 0 || bps > 500) throw new Error("FEE_BPS must be an integer from 0 to 500");
  return { bps, burnMint: new PublicKey(mint).toBase58(), slippageBps: 300 };
}

function env() {
  // Locally, Jupiter's keyless tier is enough to develop against; production needs a key for its rate limits.
  const apiKey = process.env.JUPITER_API_KEY ?? "";
  if (!apiKey && process.env.VERCEL) throw new Error("JUPITER_API_KEY is not set");
  const rpc = process.env.RPC_URL;
  // The public RPC rate-limits hard and blocks the token-account queries this app needs.
  if (!rpc && process.env.VERCEL) throw new Error("RPC_URL is not set");
  return { apiKey, connection: new Connection(rpc ?? "https://api.mainnet-beta.solana.com", "confirmed") };
}

// Best-effort per-IP limiter. Serverless instances don't share memory, so this only blunts bursts
// against one warm instance; the real limit is the Vercel WAF rule described in the README.
// `cost` lets a bucket count work instead of requests (the plan bucket charges one unit per token).
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(req: Request, bucket: string, perMinute: number, cost = 1) {
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.reset < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { n: cost, reset: now + 60_000 });
  } else if ((e.n += cost) > perMinute) {
    throw new HttpError(429, "Duster is busy right now. Try again in a minute.");
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

// A chunked preview sends several /api/plan requests in a row for the same owner. Reusing one balance and
// price read for a few seconds keeps RPC and Jupiter load per preview roughly constant. /api/holdings always
// reads fresh (and refreshes this cache), so a retry after a send starts from current balances.
const HOLDINGS_TTL_MS = 20_000;
const holdingsCache = new Map<string, { at: number; rows: Promise<Awaited<ReturnType<typeof readHoldingsWithValue>>> }>();
// The output token's price barely moves between the requests of one chunked preview; reuse it for 20s.
const outPrices = new Map<string, { at: number; value: Promise<PriceInfo | undefined> }>();
function outPriceFor(apiKey: string, mint: string) {
  const hit = outPrices.get(mint);
  if (hit && Date.now() - hit.at < 20_000) return hit.value;
  const value = getPrices(apiKey, [mint]).then((p) => p[mint]);
  outPrices.set(mint, { at: Date.now(), value });
  value.then((v) => !v && outPrices.delete(mint), () => outPrices.delete(mint));
  return value;
}

function holdingsWithValue(apiKey: string, connection: Connection, owner: PublicKey, { fresh = false } = {}) {
  const key = owner.toBase58();
  const now = Date.now();
  const hit = holdingsCache.get(key);
  if (!fresh && hit && now - hit.at < HOLDINGS_TTL_MS) return hit.rows;
  if (holdingsCache.size > 2_000) holdingsCache.clear();
  const rows = readHoldingsWithValue(apiKey, connection, owner);
  holdingsCache.set(key, { at: now, rows });
  rows.catch(() => holdingsCache.get(key)?.rows === rows && holdingsCache.delete(key));
  return rows;
}

async function readHoldingsWithValue(apiKey: string, connection: Connection, owner: PublicKey) {
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

// The config payload is the same for every visitor (fee settings from env, estimate-only prices), so one
// warm instance answers from memory for a minute instead of spending Jupiter quota on every page load.
let configMemo: { at: number; ttl: number; body: unknown } | null = null;
export const config = wrap(async (req) => {
  rateLimit(req, "config", 30);
  if (configMemo && Date.now() - configMemo.at < configMemo.ttl) return configMemo.body;
  const fee = feeConfig();
  const burnMint = fee && fee.bps > 0 ? fee.burnMint : null;
  const { apiKey } = env();
  let ok = true;
  // USD prices of the default outputs, so the UI can estimate before a preview. Estimates only: the plan
  // re-quotes everything, and a price outage must not break the page.
  const pricesP = getPrices(apiKey, [SOL, USDC, USDT, ...(burnMint ? [burnMint] : [])])
    .then((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.usdPrice])))
    .catch(() => ((ok = false), {}));
  let body: unknown;
  if (!burnMint) body = { fee: null, prices: await pricesP, jupRps: JUP_RPS };
  else {
    // The fee settings come from env, so a token-metadata outage must not hide them: the UI needs the burn
    // mint to keep that token out of the sell list.
    const [[meta], prices] = await Promise.all([
      searchTokens(apiKey, burnMint)
        .then((r) => r.filter((t) => t.id === burnMint))
        .catch((): TokenMeta[] => ((ok = false), [])),
      pricesP,
    ]);
    body = {
      fee: {
        bps: fee!.bps,
        burnToken: { id: burnMint, symbol: meta?.symbol ?? "BURN", name: meta?.name ?? "", icon: meta?.icon ?? null, verified: !!meta?.isVerified },
      },
      prices,
      jupRps: JUP_RPS, // the UI plans chunks in parallel only when the Jupiter plan has room for it
    };
  }
  configMemo = { at: Date.now(), ttl: ok ? 60_000 : 10_000, body };
  return body;
});

export const holdings = wrap(async (req) => {
  rateLimit(req, "holdings", 20);
  const { apiKey, connection } = env();
  const owner = pubkey(new URL(req.url).searchParams.get("owner"), "owner");
  const rows = await holdingsWithValue(apiKey, connection, owner, { fresh: true });
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
    usdPrice: typeof t.usdPrice === "number" ? t.usdPrice : null,
  }));
});

export const plan = wrap(async (req) => {
  // The UI previews in chunks, so the budget is counted in tokens (each one costs a Jupiter build plus
  // simulations), not requests: about three full 30-token previews per minute, whatever the chunk size.
  rateLimit(req, "plan", 40);
  const b = await readJson(req);
  const owner = pubkey(b.owner, "owner");
  const outMint = pubkey(b.outMint, "outMint").toBase58();
  if (!Array.isArray(b.mints) || b.mints.length === 0) throw new HttpError(400, "select at least one token");
  if (b.mints.length > MAX_TOKENS_PER_PLAN) throw new HttpError(400, `select at most ${MAX_TOKENS_PER_PLAN} tokens at a time`);
  rateLimit(req, "plan-tokens", 90, b.mints.length);
  const wanted = new Set<string>(b.mints.map((m: unknown) => pubkey(m, "mint").toBase58()));
  wanted.delete(outMint);
  const slippageBps = Math.min(Math.max(Math.round(Number(b.slippageBps) || 100), 1), 2000);
  const maxLossPct = Number(b.maxLossPct);
  const maxLoss = Math.min(Math.max(Number.isFinite(maxLossPct) ? maxLossPct : 10, 0), 50) / 100;
  const { apiKey, connection } = env();

  // Re-read balances and prices server-side; never trust amounts from the browser.
  const rows = await holdingsWithValue(apiKey, connection, owner);
  const outPrice = await outPriceFor(apiKey, outMint);
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

  const stats = { calls: 0, r429: 0, ms: 0, build: 0, buildMs: 0 };
  const t0 = Date.now();
  const result = await jupStats.run(stats, () => planSwaps({
    connection,
    apiKey,
    owner,
    outMint,
    outInfo: outPrice,
    items,
    slippageBps,
    maxAccounts: 64,
    maxLoss,
    closeSource: b.closeAccounts !== false,
    fee: feeConfig(),
  }));
  console.log(JSON.stringify({ plan: { tokens: items.length, txs: result.batches.length, skipped: result.skipped.length, ms: Date.now() - t0, out: outMint.slice(0, 4), jup: stats } }));
  // Jupiter/RPC error text can be noisy or leak details; keep reasons short and generic.
  // A Jupiter rate limit is not "no market": say so, so the UI can offer a retry instead of giving up.
  skipped.push(
    ...result.skipped.map((s) => ({
      mint: s.mint,
      reason: s.reason.startsWith("no route") ? (/\b429\b/.test(s.reason) ? "quote service busy; try again shortly" : "no route found") : s.reason,
    })),
  );
  const fee = feeConfig();
  const feeApplied = feeApplies(fee, outMint);
  return {
    skipped,
    feeApplied,
    burnMint: feeApplied ? fee.burnMint : null,
    outPrice: outPrice.usdPrice,
    txs: result.batches.map((bt) => {
      const bytes = bt.tx.serialize();
      return {
        tx: Buffer.from(bytes).toString("base64"),
        bytes: bytes.length,
        legs: bt.legs.map((l) => ({
          mint: l.holding.mint,
          usdIn: l.usdIn,
          outAmount: Number(l.build.outAmount) / 10 ** outPrice.decimals,
          // Guaranteed minimum after slippage, before the fee (the fee is taken from this amount).
          minOut: Number(l.build.otherAmountThreshold) / 10 ** outPrice.decimals,
        })),
        fee: bt.fee && {
          amountIn: Number(bt.fee.amountIn) / 10 ** outPrice.decimals,
          usd: (Number(bt.fee.amountIn) / 10 ** outPrice.decimals) * outPrice.usdPrice,
          burned: Number(bt.fee.burn.amount) / 10 ** bt.fee.burn.decimals,
        },
      };
    }),
  };
});

/** Parse a request's base64 transactions, enforcing count and size caps. */
function readTxs(b: any): { raw: Buffer; tx: VersionedTransaction }[] {
  if (!Array.isArray(b.txs) || b.txs.length === 0 || b.txs.length > MAX_TXS_PER_SEND) throw new HttpError(400, "bad transactions");
  return b.txs.map((t: unknown) => {
    if (typeof t !== "string" || t.length > 2000) throw new HttpError(400, "bad transaction");
    const raw = Buffer.from(t, "base64");
    if (raw.length > MAX_TX_BYTES) throw new HttpError(400, "transaction too large");
    try {
      return { raw, tx: VersionedTransaction.deserialize(raw) };
    } catch {
      throw new HttpError(400, "bad transaction");
    }
  });
}

/**
 * Re-stamp unsigned transactions with a fresh blockhash right before the wallet prompt. A transaction is only
 * valid for ~60s after its blockhash, and previewing, reviewing and approving can easily take longer than that.
 */
export const refresh = wrap(async (req) => {
  rateLimit(req, "refresh", 20);
  const txs = readTxs(await readJson(req));
  // Only unsigned ones: changing the blockhash would invalidate any signature anyway.
  if (txs.some(({ tx }) => tx.signatures.some((sig) => sig.some((byte) => byte !== 0)))) throw new HttpError(400, "transaction is already signed");
  const { connection } = env();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return {
    lastValidBlockHeight,
    txs: txs.map(({ tx }) => {
      tx.message.recentBlockhash = blockhash;
      return Buffer.from(tx.serialize()).toString("base64");
    }),
  };
});

export const send = wrap(async (req) => {
  rateLimit(req, "send", 10);
  // Only relay well-formed, fully signed transactions so this can't be used as a generic spam relay.
  const txs = readTxs(await readJson(req));
  if (txs.some(({ tx }) => tx.signatures.some((sig) => sig.every((byte) => byte === 0)))) throw new HttpError(400, "transaction is not signed");
  const raws = txs.map(({ raw }) => raw);
  const { connection } = env();
  // Each transaction stands alone (its own swap and buy-and-burn), so they can go out together.
  // A preflight rejection means the RPC never forwarded the transaction, so the answer is definitive. Anything
  // else (timeouts, dropped connections, RPC errors after forwarding) is uncertain: the transaction may still
  // land, and `uncertain: true` tells the UI to keep tracking it by signature.
  const sigs = await Promise.all(
    raws.map(async (raw: Buffer): Promise<string | { error: string; uncertain?: true }> => {
      try {
        return await connection.sendRawTransaction(raw, { maxRetries: 3 });
      } catch (e) {
        console.error(e);
        const s = String(e);
        if (/blockhash not found/i.test(s)) return { error: "expired, please preview again" };
        if (/simulation failed|preflight/i.test(s)) return { error: "rejected by the network (simulation failed)" };
        return { error: "no clear answer from the network", uncertain: true };
      }
    }),
  );
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
  const withHeight = new URL(req.url).searchParams.get("h") === "1";
  // Height first, statuses second: a transaction that landed before the height was read shows up in the
  // statuses, so "past lastValidBlockHeight and still no status" can be trusted (the UI also wants it twice).
  const blockHeight = withHeight ? await connection.getBlockHeight("confirmed") : null;
  const { value } = await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true });
  const statuses = value.map((v) => (v ? { status: v.confirmationStatus, err: v.err } : null));
  // With h=1 the current block height comes along, so the UI can compare it with lastValidBlockHeight from
  // /api/refresh and say "expired" for certain. Without it, the original array shape is kept.
  return withHeight ? { statuses, blockHeight } : statuses;
});
