import { AsyncLocalStorage } from "node:async_hooks";
import { Connection, type ConnectionConfig } from "@solana/web3.js";

/**
 * Requests per second our RPC plan allows, for all calls and for sendTransaction, which providers cap far lower
 * (Helius Free: 10 and 1; Developer: 50 and 5; Business: 200 and 50). A preview's simulations and /api/send's
 * whole batch used to go out at once; most came back 429, web3.js gave up after about 7.5s, and signed swaps were
 * never forwarded. Calls from one instance are now spaced out to these rates, and a 429 backs off and tries again.
 * The defaults are Helius Free's; set RPC_RPS and RPC_SEND_RPS to your plan's.
 */
export const RPC_RPS = Math.max(1, Number(process.env.RPC_RPS) || 10);
export const RPC_SEND_RPS = Math.max(0.2, Number(process.env.RPC_SEND_RPS) || 1);
/** How long a call keeps retrying after its first 429. */
const RETRY_MS = 10_000;
/**
 * A send gives up this long after it was handed over, queue included: its blockhash is good for about a minute from
 * the wallet prompt, and /api/send has to answer within its 60s limit even for the last of a paced batch.
 */
const SEND_DEADLINE_MS = 40_000;

/** Per-request counts (wrap() in handlers.ts opens one per API request), logged with the plan and send lines. */
export const rpcStats = new AsyncLocalStorage<{ calls: number; r429: number; waitMs: number }>();

// When the next call, and the next sendTransaction, may start. A send waits for its own slot first and only then
// takes a general one, so a queue of sends never holds up other calls.
let nextCall = 0;
let nextSend = 0;
async function slot(cost: number, send: boolean): Promise<number> {
  const t0 = Date.now();
  if (send) {
    const at = Math.max(t0, nextSend);
    nextSend = at + 1000 / RPC_SEND_RPS;
    if (at > t0) await sleep(at - t0);
  }
  const now = Date.now();
  const at = Math.max(now, nextCall);
  nextCall = at + (1000 * cost) / RPC_RPS;
  if (at > now) await sleep(at - now);
  return Date.now() - t0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pacedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let cost = 1;
  let send = false;
  try {
    const body = JSON.parse(String(init?.body));
    const reqs: { method?: string }[] = Array.isArray(body) ? body : [body];
    cost = Math.max(1, reqs.length);
    send = reqs.some((r) => r?.method === "sendTransaction");
  } catch {}
  const stats = rpcStats.getStore();
  const started = Date.now();
  let first429 = 0;
  for (let attempt = 0; ; attempt++) {
    const waited = await slot(cost, send);
    const res = await fetch(input, init);
    if (stats) (stats.calls++, (stats.waitMs += waited));
    if (res.status !== 429) return res;
    if (stats) stats.r429++;
    const now = Date.now();
    first429 ||= now;
    if (send ? now - started > SEND_DEADLINE_MS : now - first429 > RETRY_MS) return res;
    await res.arrayBuffer().catch(() => {});
    // Other instances and functions share the plan's budget, so back this instance off as a whole (Retry-After when
    // the RPC gives one), with jitter so instances don't retry in lockstep.
    const after = Number(res.headers.get("retry-after")) * 1000;
    const wait = (after > 0 ? Math.min(after, 5000) : Math.min(500 * 2 ** attempt, 4000)) * (0.75 + Math.random() / 2);
    nextCall = Math.max(nextCall, now + wait);
    if (send) nextSend = Math.max(nextSend, now + wait);
  }
}

/** A Connection whose calls are paced to the RPC plan; retrying a 429 is left to pacedFetch, not web3.js. */
export function rpcConnection(url: string): Connection {
  return new Connection(url, { commitment: "confirmed", fetch: pacedFetch as ConnectionConfig["fetch"], disableRetryOnRateLimit: true });
}

/** web3.js reports an RPC's HTTP 429 as an Error whose message starts with the status ("429 Too Many Requests: …"). */
export const isRateLimited = (e: unknown) => /\b429\b/.test(String(e));
