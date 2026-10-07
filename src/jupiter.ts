import { AsyncLocalStorage } from "node:async_hooks";

const BASE = "https://api.jup.ag";
/** Jupiter answers in well under a second; a call that hangs must not hold a preview until the function times out. */
const TIMEOUT_MS = 8_000;

export interface ApiInstruction {
  programId: string;
  accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[];
  data: string; // base64
}

export interface BuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
}

export interface PriceInfo {
  usdPrice: number;
  decimals: number;
}

/**
 * A failed Jupiter call. `busy` means Jupiter couldn't answer just now (rate limit, server error, timeout, network),
 * which says nothing about the token: callers say "try again", never "no route".
 */
export class JupiterError extends Error {
  constructor(message: string, readonly status: number, readonly busy: boolean) {
    super(message);
  }
}

/** Per-request call stats (set by the caller with jupStats.run) so slow previews can be diagnosed from logs. */
export const jupStats = new AsyncLocalStorage<{ calls: number; r429: number; ms: number; build: number; buildMs: number; err: number }>();

/**
 * Requests per second our Jupiter plan allows (Free = 1, Developer = 10, …; keyless = 0.5). Jupiter enforces it per
 * account over a 60s sliding window, so calls from one instance are spaced out to it instead of bursting into 429s.
 */
export const JUP_RPS = Math.max(0.2, Number(process.env.JUPITER_RPS) || (process.env.JUPITER_API_KEY ? 1 : 0.5));
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / JUP_RPS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function get<T>(apiKey: string, path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const stats = jupStats.getStore();
  let failed = 0;
  for (let attempt = 0; ; attempt++) {
    await pace();
    const t0 = Date.now();
    let res: Response;
    let body: string;
    try {
      res = await fetch(url, { headers: apiKey ? { "x-api-key": apiKey } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
      body = await res.text();
    } catch (e) {
      // Timed out or never connected. One more try; the second failure is reported as busy.
      if (stats) (stats.calls++, stats.err++, (stats.ms += Date.now() - t0));
      if (++failed < 2) continue;
      throw new JupiterError(`${path} ${(e as Error).name === "TimeoutError" ? "timed out" : "unreachable"}`, 0, true);
    }
    if (stats) {
      const dt = Date.now() - t0;
      stats.calls++; stats.ms += dt;
      if (path.includes("/build")) { stats.build++; stats.buildMs += dt; }
      if (res.status === 429) stats.r429++;
      else if (res.status >= 500) stats.err++;
    }
    if (res.status === 429 && attempt < 6) {
      // Other instances share the account's window: wait until Jupiter says the oldest request ages out.
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = Number.isFinite(reset) && reset > Date.now() ? Math.min(reset - Date.now() + 100, 10_000) : 1000;
      nextSlot = Math.max(nextSlot, Date.now() + wait);
      continue;
    }
    // A server error is usually momentary: one more try after a short pause.
    if (res.status >= 500 && ++failed < 2) {
      nextSlot = Math.max(nextSlot, Date.now() + 500);
      continue;
    }
    if (!res.ok) {
      // Jupiter's gateway request id matches their request logs, so a failure can be traced with their support.
      const id = res.headers.get("x-api-gateway-request-id");
      throw new JupiterError(`${path} ${res.status}: ${body.slice(0, 300)}${id ? ` (request ${id})` : ""}`, res.status, res.status === 429 || res.status >= 500);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new JupiterError(`${path} ${res.status}: not JSON`, res.status, true);
    }
  }
}

/** USD prices for up to N mints (batched by 50). Mints without a reliable price are omitted. */
export async function getPrices(apiKey: string, mints: string[]): Promise<Record<string, PriceInfo>> {
  const out: Record<string, PriceInfo> = {};
  for (let i = 0; i < mints.length; i += 50) {
    const chunk = mints.slice(i, i + 50);
    Object.assign(out, await get(apiKey, "/price/v3", { ids: chunk.join(",") }));
  }
  return out;
}

/** Raw swap instructions (Router / Metis) so several swaps can be composed into one transaction. */
export function getBuild(
  apiKey: string,
  p: { inputMint: string; outputMint: string; amount: string; taker: string; slippageBps: number; maxAccounts: number },
): Promise<BuildResponse> {
  return get(apiKey, "/swap/v2/build", {
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount,
    taker: p.taker,
    slippageBps: String(p.slippageBps),
    maxAccounts: String(p.maxAccounts),
  });
}

export interface TokenMeta {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  usdPrice?: number;
  isVerified?: boolean;
}

/** Token search by symbol, name, mint, or comma-separated mints (max 100). */
export function searchTokens(apiKey: string, query: string): Promise<TokenMeta[]> {
  return get(apiKey, "/tokens/v2/search", { query });
}
