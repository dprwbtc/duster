const BASE = "https://api.jup.ag";

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

async function get<T>(apiKey: string, path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "x-api-key": apiKey } });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
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
