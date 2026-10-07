// HTTP handlers shared by the Vercel functions (api/*.ts) and the local dev server (src/server.ts).
// Everything here is reachable by anyone on the internet once deployed, so validate all input and
// never return internal error details (RPC URLs can embed API keys).
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { JUP_RPS, JupiterError, getPrices, jupStats, searchTokens, type PriceInfo, type TokenMeta } from "./jupiter.js";
import { getHoldings, getTokenAccounts, parseTokenAccount, type TokenAccount } from "./wallet.js";
import { feeApplies, planSwaps, type FeeConfig } from "./plan.js";
import { NO_SOL } from "./pack.js";
import { readMeta } from "./meta.js";
import { classifyMints, hintsFrom, isNftKind, kindCounts, type MintClass, type NftKind } from "./nft.js";
import { RpcUnavailable, tokenImage } from "./imgproxy.js";
import { planReclaim, type ReclaimItem } from "./reclaim.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MAX_TOKENS_PER_PLAN = 30; // each token costs a Jupiter /build call plus simulations
const MAX_TXS_PER_SEND = 30; // one transaction per token, so this matches MAX_TOKENS_PER_PLAN
const MAX_TX_BYTES = 1232;
const MAX_RECLAIM_ACCOUNTS = 400; // per /api/reclaim request; about 20 closes fit in one transaction
const BURN_MAX_USD = 1; // "burn & close" is only for dust worth less than this (or with no price at all)
const NOT_SOLD = "NFTs aren't sold here";
const NOT_SOLD_COLLECTIBLE = "collectibles aren't sold here";
const UNSURE = "couldn't check whether it's an NFT right now; try again";

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
      // Jupiter being slow or rate-limited is momentary and says nothing about the wallet: tell the user to retry.
      if (e instanceof JupiterError && e.busy) return Response.json({ error: "Prices and quotes are busy right now. Try again in a moment." }, { status: 503 });
      return Response.json({ error: "Something went wrong on the server. Please try again." }, { status: 500 });
    }
  };
}

async function metaFor(apiKey: string, mints: string[]): Promise<Map<string, TokenMeta>> {
  const batches: string[] = [];
  for (let i = 0; i < mints.length; i += 100) batches.push(mints.slice(i, i + 100).join(","));
  // requested together; pace() spaces them to the Jupiter plan's rate
  const got = await Promise.all(batches.map((q) => searchTokens(apiKey, q)));
  return new Map(got.flat().map((t) => [t.id, t]));
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

/**
 * Whether a holding is left alone as an NFT or collectible, from the classifier and Jupiter's price: a decimals-0
 * mint with no NFT marker (`tokenIfPriced`) is a token only when Jupiter prices it. No classification at all is
 * treated as an unreadable NFT.
 */
function leftAlone(c: MintClass | undefined, price: number | null | undefined): { nft: boolean; kind: NftKind | null; unsure: boolean } {
  if (!c) return { nft: true, kind: "nft", unsure: true };
  if (!c.nft || (c.tokenIfPriced && typeof price === "number")) return { nft: false, kind: null, unsure: false };
  return { nft: true, kind: c.kind ?? "nft", unsure: !!c.unsure };
}

async function readHoldingsWithValue(apiKey: string, connection: Connection, owner: PublicKey) {
  const holdings = (await getHoldings(connection, owner)).filter((h) => h.mint !== SOL);
  const mints = [...new Set(holdings.map((h) => h.mint))];
  // NFTs are never sold, burned or listed as tokens, so they don't spend Jupiter quota either (RPC only, cached).
  // Collectibles with no NFT marker ride along in the same price batch: the price is what says "token" for them.
  const cls = await classifyMints(connection, mints, hintsFrom(holdings));
  const priceable = mints.filter((m) => { const c = cls.get(m); return !!c && (!c.nft || !!c.tokenIfPriced); });
  const prices = await getPrices(apiKey, priceable);
  const tokens = mints.filter((m) => !leftAlone(cls.get(m), prices[m]?.usdPrice).nft);
  const meta = await metaFor(apiKey, tokens);
  return holdings.map((h) => {
    const c = cls.get(h.mint);
    const la = leftAlone(c, prices[h.mint]?.usdPrice);
    const nft = la.nft;
    const price = nft ? null : prices[h.mint]?.usdPrice ?? null;
    const m = nft ? undefined : meta.get(h.mint);
    return {
      h,
      nft,
      nftKind: la.kind,
      nftUnsure: la.unsure,
      price,
      usd: price === null ? null : h.uiAmount * price,
      symbol: m?.symbol ?? (nft ? c?.meta?.symbol || null : null),
      name: m?.name ?? (nft ? c?.meta?.name || null : null),
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
  // NFT and collectible rows come back marked ({ nft: true, nftKind }) so the page can say how many it leaves alone,
  // never as tokens; `nftUnsure` when the chain couldn't be read just now (left alone too, but not called an NFT)
  return rows.map(({ h, nftKind, nftUnsure, ...r }) => ({ mint: h.mint, amount: h.uiAmount, frozen: h.frozen, ...r, ...(r.nft ? { nftKind, ...(nftUnsure ? { nftUnsure } : {}) } : {}) }));
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
  const skipped: { mint: string; reason: string }[] = [];

  // NFTs are refused before anything else, and before any Jupiter call (RPC only, and usually cached by /api/holdings).
  // The default outputs are known tokens and skip the read. A mint the chain says is certainly an NFT goes now; one
  // that couldn't be read (no token-account decimals to go on yet) or whose answer depends on its price is settled
  // below, by the holdings read, which classifies with the account's decimals and prices collectibles.
  const fee = feeConfig();
  const knownTokens = new Set([SOL, USDC, USDT, ...(fee ? [fee.burnMint] : [])]);
  const cls = await classifyMints(connection, [...wanted, ...(knownTokens.has(outMint) ? [] : [outMint])]);
  for (const mint of wanted) {
    const c = cls.get(mint);
    if (c?.nft && !c.unsure && !c.tokenIfPriced) (skipped.push({ mint, reason: isNftKind(c.kind) ? NOT_SOLD : NOT_SOLD_COLLECTIBLE }), wanted.delete(mint));
  }
  const oc = cls.get(outMint);
  if (oc?.nft && oc.unsure) throw new HttpError(503, "Couldn't check the token you're swapping into just now. Try again in a moment.");
  if (oc?.nft && !oc.tokenIfPriced) throw new HttpError(400, `That's ${isNftKind(oc.kind) ? "an NFT" : "a collectible"}, not a token. Pick a token to swap into.`);
  if (!wanted.size) return { skipped, feeApplied: false, burnMint: null, outPrice: null, txs: [] };

  // Re-read balances and prices server-side; never trust amounts from the browser.
  const rows = await holdingsWithValue(apiKey, connection, owner);
  const outPrice = await outPriceFor(apiKey, outMint);
  // an output collectible (decimals 0, no NFT marker) is a token only with a price, and this is where it's told
  if (!outPrice && oc?.tokenIfPriced) throw new HttpError(400, "That's a collectible, not a token. Pick a token to swap into.");
  if (!outPrice) throw new HttpError(400, "The token you're swapping into has no reliable price, so swaps can't be checked. Pick another.");

  const items: { h: (typeof rows)[number]["h"]; usd: number }[] = [];
  for (const mint of wanted) {
    const r = rows.find((x) => x.h.mint === mint);
    if (!r) skipped.push({ mint, reason: "not in wallet" });
    else if (r.nft) skipped.push({ mint, reason: r.nftUnsure ? UNSURE : isNftKind(r.nftKind) ? NOT_SOLD : NOT_SOLD_COLLECTIBLE });
    else if (r.h.frozen) skipped.push({ mint, reason: "account frozen" });
    else if (r.usd === null) skipped.push({ mint, reason: "no reliable price" });
    else items.push({ h: r.h, usd: r.usd });
  }

  const stats = { calls: 0, r429: 0, ms: 0, build: 0, buildMs: 0, err: 0 };
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
    fee,
  }));
  console.log(JSON.stringify({ plan: { tokens: items.length, txs: result.batches.length, skipped: result.skipped.length, ms: Date.now() - t0, out: outMint.slice(0, 4), jup: stats } }));
  // Jupiter/RPC error text can be noisy or leak details; keep reasons short and generic. (A busy Jupiter is
  // already reported as "quote service busy" by the planner, so the UI offers a retry instead of giving up.)
  skipped.push(...result.skipped.map((s) => ({ mint: s.mint, reason: s.reason.startsWith("no route") ? "no route found" : s.reason })));
  const feeApplied = feeApplies(fee, outMint);
  // When swaps were skipped for lack of SOL, say how much the wallet has, so the page can say what's missing.
  const solLamports = skipped.some((s) => s.reason === NO_SOL) ? await connection.getBalance(owner).catch(() => null) : null;
  return {
    skipped,
    feeApplied,
    burnMint: feeApplied ? fee.burnMint : null,
    outPrice: outPrice.usdPrice,
    ...(solLamports !== null ? { solLamports } : {}),
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

/* ================= token images ================= */

// Same-origin token images, so the visitor's browser never contacts a host the token's creator picked.
// Binary response, so not wrap(): success is a small WebP the CDN can keep for a month; "no usable image" is a
// 404 the CDN keeps for an hour (so a garbage mint can't make us re-fetch on every view); an image host that
// rate-limited us or timed out is a 503 kept for five minutes; our own RPC failing or a rate limit is never cached.
const IMG_HEADERS = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" };
const imgMiss = (status: number, cache: string) => new Response(null, { status, headers: { ...IMG_HEADERS, "Cache-Control": cache } });
export async function img(req: Request): Promise<Response> {
  try {
    rateLimit(req, "img", 300); // a list scrolling into view asks for many at once; this only stops floods
  } catch {
    return imgMiss(429, "no-store");
  }
  // The page asks for /i/<mint> (a rewrite to here, see vercel.json) and nothing else. The CDN keys on the whole
  // URL, so any extra query parameter would be a fresh cache miss (and a fresh RPC read and upstream fetch on a
  // cold instance); those get a cacheable 400 instead. The mint may arrive in the path, the query, or both
  // (depending on how the rewrite is presented), but never as two different values.
  let mint: string;
  try {
    const url = new URL(req.url);
    const fromPath = url.pathname.match(/^\/i\/([^/]+)$/)?.[1];
    const keys = [...url.searchParams.keys()];
    if (keys.some((k) => k !== "mint") || keys.length > 1) throw 0;
    const fromQuery = url.searchParams.get("mint");
    if (fromPath && fromQuery && fromPath !== fromQuery) throw 0;
    mint = pubkey(fromPath ?? fromQuery, "mint").toBase58();
    if (mint !== (fromPath ?? fromQuery)) throw 0; // one spelling per mint, one cache entry
  } catch {
    return imgMiss(400, "public, max-age=86400, s-maxage=86400");
  }
  try {
    const { bytes, transient } = await tokenImage(env().connection, mint);
    if (!bytes) return transient ? imgMiss(503, "public, max-age=60, s-maxage=300") : imgMiss(404, "public, max-age=3600, s-maxage=3600");
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...IMG_HEADERS,
        "Content-Type": "image/webp",
        "Content-Length": String(bytes.length),
        "Cache-Control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
      },
    });
  } catch (e) {
    if (!(e instanceof RpcUnavailable)) console.error(e);
    return imgMiss(503, "no-store");
  }
}

/* ================= the cleanup: rent reclaim ================= */

// Prices only for accounts that still hold something, and only when burning is on the table (the burn section was
// opened, or /api/reclaim was asked to burn). From memory when possible: a price from the last minute or two is
// plenty to tell dust from value. Locally, where every handler shares one process, a recent /api/holdings read is
// reused; on Vercel each api/*.ts is its own function with its own memory, so there it's one paced Jupiter /price
// call per 50 mints, remembered for a minute on that instance.
const PRICE_MEMO_MS = 60_000;
const priceMemo = new Map<string, { at: number; usd: number | null }>();
async function pricesFor(apiKey: string, owner: PublicKey, mints: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!mints.length) return out;
  const hit = holdingsCache.get(owner.toBase58());
  if (hit && Date.now() - hit.at < 120_000) {
    try {
      for (const r of await hit.rows) out.set(r.h.mint, r.price);
    } catch {}
  }
  const now = Date.now();
  const missing = mints.filter((m) => {
    if (out.has(m)) return false;
    const p = priceMemo.get(m);
    if (p && now - p.at < PRICE_MEMO_MS) return out.set(m, p.usd), false;
    return true;
  });
  if (missing.length) {
    const got = await getPrices(apiKey, missing); // throws on failure: the caller must not treat that as "no price"
    if (priceMemo.size > 5_000) priceMemo.clear();
    for (const m of missing) {
      const usd = got[m]?.usdPrice ?? null;
      priceMemo.set(m, { at: now, usd });
      out.set(m, usd);
    }
  }
  return out;
}

/** Jupiter's names and verified flags, only when this owner's holdings are already in memory (no extra calls). */
async function cachedJupMeta(owner: PublicKey) {
  const out = new Map<string, { symbol: string | null; name: string | null; verified: boolean }>();
  const hit = holdingsCache.get(owner.toBase58());
  if (hit && Date.now() - hit.at < 120_000) {
    try {
      for (const r of await hit.rows) out.set(r.h.mint, { symbol: r.symbol, name: r.name, verified: r.verified });
    } catch {}
  }
  return out;
}

/** Whether the owner can close this account, and if not, why (in the words the UI shows). */
function closeCheck(a: TokenAccount, owner: string): { ok: true } | { ok: false; reason: string } {
  if (a.owner !== owner) return { ok: false, reason: "not owned by this wallet" };
  if (a.frozen) return { ok: false, reason: "frozen" };
  if (a.closeAuthority && a.closeAuthority !== owner) return { ok: false, reason: "close authority is someone else" };
  return { ok: true };
}

/**
 * Why an account that still holds tokens may never be burned, whatever its price says, or null. NFTs and collectibles
 * (by the on-chain classifier in nft.ts) never are. Nor is anything else with no decimals: Jupiter has no price for
 * most of those, so "no price" there means "value unknown", not "worthless" (an old SFT can look exactly like a
 * 0-decimal coin). The burn token is the project's own: it's never offered for burning here (the swaps' fee burns it
 * on purpose).
 */
function burnBlock(a: TokenAccount, c: MintClass | undefined): string | null {
  if (a.native) return "wrapped SOL is closed (unwrapped), never burned";
  // no classification at all, or an unreadable mint, is treated like an NFT: burning can't be undone
  if (!c || (c.nft && (c.unsure || isNftKind(c.kind)))) return "it's an NFT, and NFTs are never burned here";
  if (c.nft) return "it's a collectible, and collectibles are never burned here";
  if (a.decimals === 0) return "it has no decimals, so its value can't be told; it's never burned here";
  const burnMint = process.env.BURN_TOKEN_MINT?.trim();
  if (burnMint && a.mint === burnMint) return "that's the burn token; keep it or sell it instead";
  return null;
}

export const accounts = wrap(async (req) => {
  rateLimit(req, "accounts", 20);
  const { apiKey, connection } = env();
  const params = new URL(req.url).searchParams;
  const owner = pubkey(params.get("owner"), "owner");
  // Prices cost Jupiter quota (shared by everyone, 1 request/second on the Free plan), and they only matter for
  // "burn & close". The empty-pockets card and the cleanup list ask without them (RPC only); the page asks again
  // with prices=1 only when someone opens the burn section.
  const withPrices = params.get("prices") === "1";
  const ownerStr = owner.toBase58();
  const list = await getTokenAccounts(connection, owner);
  const program = new Map(list.map((a) => [a.mint, a.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? ("token-2022" as const) : ("token" as const)]));
  // RPC only; it also reads the names, so readMeta below answers from memory for every mint it could read
  const cls = await classifyMints(connection, [...program.keys()], hintsFrom(list));
  const held = withPrices ? [...new Set(list.filter((a) => a.rawAmount > 0n && !burnBlock(a, cls.get(a.mint))).map((a) => a.mint))] : [];
  let priceError = false;
  const [prices, meta, jup] = await Promise.all([
    pricesFor(apiKey, owner, held).catch((e) => (console.error(e), (priceError = true), new Map<string, number | null>())),
    // names are nice to have; a slow or failing metadata read must not hide the accounts themselves
    readMeta(connection, [...program.keys()], program).catch((e) => (console.error(e), new Map())),
    cachedJupMeta(owner),
  ]);
  const rows = list.map((a) => {
    const chk = closeCheck(a, ownerStr);
    const empty = a.rawAmount === 0n;
    const c = cls.get(a.mint);
    // An account holding an NFT or collectible is never closable or burnable. An EMPTY account whose mint is one holds
    // nothing (it already left), so closing it only returns the rent: it stays closable, in its own group on the page.
    // A collectible with no NFT marker (`tokenIfPriced`) may turn out to be a priced 0-decimal coin; this read has no
    // prices, so the page settles that from its pockets list. `nftUnsure`: the chain couldn't be read just now.
    const nft = !c || c.nft;
    const nftUnsure = nft && (!c || !!c.unsure);
    // could be burned and closed, value permitting (the page shows the burn section only for these)
    const burnCandidate = chk.ok && !empty && !burnBlock(a, c);
    const price = withPrices && burnCandidate ? prices.get(a.mint) ?? null : null;
    const usd = price === null ? null : a.uiAmount * price;
    // Burning is irreversible, so it's offered only when we know the value: below $1, or no price anywhere.
    // If prices weren't asked for, or the lookup itself failed, nothing is offered for burning.
    const burnable = burnCandidate && withPrices && !priceError && (usd === null || usd < BURN_MAX_USD);
    const j = jup.get(a.mint), m = meta.get(a.mint)?.meta;
    return {
      address: a.address.toBase58(),
      mint: a.mint,
      program: program.get(a.mint),
      amount: a.rawAmount.toString(),
      decimals: a.decimals,
      uiAmount: a.uiAmount,
      frozen: a.frozen,
      native: a.native,
      rentLamports: a.rentLamports,
      lamports: a.lamports,
      closeAuthority: a.closeAuthority,
      // wrapped SOL can always be closed: closing just unwraps it into the wallet
      closable: chk.ok && (empty || a.native),
      reason: !chk.ok ? chk.reason : empty || a.native ? undefined : !nft ? "has balance" : nftUnsure || isNftKind(c?.kind) ? "holds an NFT" : "holds a collectible",
      burnable,
      burnCandidate,
      // why a non-empty account isn't a burn candidate even though it could be closed (NFT, burn token)
      burnBlock: chk.ok && !empty && !a.native ? burnBlock(a, c) ?? undefined : undefined,
      nft,
      nftKind: nft ? c?.kind ?? "nft" : null,
      ...(nftUnsure ? { nftUnsure: true } : {}),
      ...(nft && c?.tokenIfPriced ? { tokenIfPriced: true } : {}),
      withheld: a.withheld > 0n,
      symbol: j?.symbol || m?.symbol || c?.meta?.symbol || null,
      name: j?.name || m?.name || c?.meta?.name || null,
      verified: !!j?.verified,
      usd,
    };
  });
  const nfts = rows.filter((r) => r.nft);
  if (nfts.length) console.log(JSON.stringify({ accounts: { total: rows.length, nft: nfts.length, nftEmpty: nfts.filter((r) => r.amount === "0").length, kinds: kindCounts([...cls.values()]) } }));
  return { accounts: rows, priced: withPrices, priceError };
});

function addressList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `bad ${what} list`);
  return [...new Set(v.map((x) => pubkey(x, "account").toBase58()))];
}

export const reclaim = wrap(async (req) => {
  rateLimit(req, "reclaim", 20);
  const b = await readJson(req);
  const owner = pubkey(b.owner, "owner");
  const ownerStr = owner.toBase58();
  const close = addressList(b.close, "close");
  const burn = addressList(b.burn, "burn");
  if (!close.length && !burn.length) throw new HttpError(400, "pick at least one account");
  if (close.some((a) => burn.includes(a))) throw new HttpError(400, "an account can't be both closed and burned");
  if (close.length + burn.length > MAX_RECLAIM_ACCOUNTS) throw new HttpError(400, `pick at most ${MAX_RECLAIM_ACCOUNTS} accounts at a time`);
  rateLimit(req, "reclaim-accounts", 2_000, close.length + burn.length);
  const { apiKey, connection } = env();

  // Re-read every account on the server; nothing about an account is taken from the browser.
  const wanted = [...close.map((a) => ({ a, burn: false })), ...burn.map((a) => ({ a, burn: true }))];
  const infos: Awaited<ReturnType<Connection["getMultipleParsedAccounts"]>>["value"] = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const { value } = await connection.getMultipleParsedAccounts(wanted.slice(i, i + 100).map((w) => new PublicKey(w.a)));
    infos.push(...value);
  }
  const skipped: { address: string; reason: string }[] = [];
  const items: ReclaimItem[] = [];
  const burnCandidates: { w: (typeof wanted)[number]; acct: TokenAccount }[] = [];
  wanted.forEach((w, i) => {
    const acct = parseTokenAccount(new PublicKey(w.a), infos[i] as any);
    if (!acct) return skipped.push({ address: w.a, reason: "not a token account (already closed?)" });
    const chk = closeCheck(acct, ownerStr);
    if (!chk.ok) return skipped.push({ address: w.a, reason: chk.reason });
    if (!w.burn) {
      // only empty accounts close (an NFT account included: one that still holds its NFT is never closed)
      if (acct.rawAmount > 0n && !acct.native) return skipped.push({ address: w.a, reason: acct.decimals === 0 ? "it isn't empty" : "it still holds tokens" });
      return items.push({ acct, action: "close" });
    }
    if (acct.rawAmount === 0n) return items.push({ acct, action: "close" }); // nothing left to burn: a plain close
    if (acct.native) return skipped.push({ address: w.a, reason: "wrapped SOL is closed (unwrapped), never burned" });
    burnCandidates.push({ w, acct });
  });
  // Every burn is checked against the NFT classifier (RPC only), whatever the page sent: NFTs are never burned.
  if (burnCandidates.length) {
    const cls = await classifyMints(connection, burnCandidates.map((c) => c.acct.mint), hintsFrom(burnCandidates.map((c) => c.acct)));
    for (let i = burnCandidates.length - 1; i >= 0; i--) {
      const { w, acct } = burnCandidates[i];
      const block = burnBlock(acct, cls.get(acct.mint));
      if (block) (skipped.push({ address: w.a, reason: block }), burnCandidates.splice(i, 1));
    }
  }
  if (burnCandidates.length) {
    let prices: Map<string, number | null> | null = null;
    try {
      prices = await pricesFor(apiKey, owner, [...new Set(burnCandidates.map((c) => c.acct.mint))]);
    } catch (e) {
      console.error(e);
    }
    for (const { w, acct } of burnCandidates) {
      if (!prices) { skipped.push({ address: w.a, reason: "couldn't check its price right now, so it wasn't burned" }); continue; }
      const price = prices.get(acct.mint) ?? null;
      const usd = price === null ? null : acct.uiAmount * price;
      if (usd !== null && usd >= BURN_MAX_USD) { skipped.push({ address: w.a, reason: `worth about $${usd.toFixed(2)}, so it's not burned; sell it instead` }); continue; }
      items.push({ acct, action: "burn+close" });
    }
  }

  const t0 = Date.now();
  const plan = items.length ? await planReclaim(connection, owner, items) : null;
  skipped.push(...(plan?.skipped ?? []));
  // Same per-send cap as the swaps: anything past it waits for the next run.
  const batches = plan?.batches ?? [];
  for (const extra of batches.splice(MAX_TXS_PER_SEND))
    for (const it of extra.items) skipped.push({ address: it.acct.address.toBase58(), reason: `over the ${MAX_TXS_PER_SEND}-transaction limit for one prompt; reclaim it next run` });
  console.log(JSON.stringify({ reclaim: { asked: wanted.length, txs: batches.length, skipped: skipped.length, ms: Date.now() - t0 } }));
  return {
    blockhash: plan?.blockhash ?? null,
    lastValidBlockHeight: plan?.lastValidBlockHeight ?? null,
    cuPrice: plan?.cuPrice ?? null,
    skipped,
    txs: batches.map((bt) => {
      const bytes = bt.tx.serialize();
      const accounts = bt.items.map(({ acct, action }) => ({
        address: acct.address.toBase58(),
        mint: acct.mint,
        action,
        rentLamports: acct.rentLamports,
        // what lands in the wallet: the rent, plus the balance for wrapped SOL
        lamports: acct.native ? acct.lamports : acct.rentLamports,
        native: acct.native,
        uiAmount: acct.uiAmount,
      }));
      return {
        tx: Buffer.from(bytes).toString("base64"),
        bytes: bytes.length,
        accounts,
        rentLamports: accounts.reduce((s, a) => s + a.rentLamports, 0),
        lamports: accounts.reduce((s, a) => s + a.lamports, 0),
        // base fee for one signature plus the priority fee at the simulated compute limit
        feeLamports: 5_000 + Math.ceil((bt.cuLimit * (plan?.cuPrice ?? 0)) / 1_000_000),
      };
    }),
  };
});
