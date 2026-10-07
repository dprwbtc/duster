import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export interface Holding {
  mint: string;
  account: PublicKey;
  tokenProgram: PublicKey;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
  frozen: boolean;
}

export async function getHoldings(connection: Connection, owner: PublicKey): Promise<Holding[]> {
  const out: Holding[] = [];
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const reads = await Promise.all(programs.map((programId) => connection.getParsedTokenAccountsByOwner(owner, { programId })));
  for (const [i, { value }] of reads.entries()) {
    const programId = programs[i];
    for (const { pubkey, account } of value) {
      const info = account.data.parsed.info;
      const rawAmount = BigInt(info.tokenAmount.amount);
      if (rawAmount === 0n) continue;
      out.push({
        mint: info.mint,
        account: pubkey,
        tokenProgram: programId,
        rawAmount,
        decimals: info.tokenAmount.decimals,
        uiAmount: Number(info.tokenAmount.uiAmountString),
        frozen: info.state === "frozen",
      });
    }
  }
  return out;
}

/** Every token account, empty ones included: what the rent reclaim ("the cleanup") works from. */
export interface TokenAccount {
  address: PublicKey;
  owner: string;
  mint: string;
  tokenProgram: PublicKey;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
  frozen: boolean;
  native: boolean;
  /** All lamports in the account. For wrapped SOL that's the rent reserve plus the wrapped balance. */
  lamports: number;
  /** The rent part only: what closing gives back besides any wrapped SOL. */
  rentLamports: number;
  closeAuthority: string | null;
  /** Token-2022 transfer-fee tokens withheld in the account; they block a close until harvested to the mint. */
  withheld: bigint;
}

const PROGRAMS: Record<string, PublicKey> = { "spl-token": TOKEN_PROGRAM_ID, "spl-token-2022": TOKEN_2022_PROGRAM_ID };

/**
 * Reads a jsonParsed token account (from getParsedTokenAccountsByOwner or getMultipleParsedAccounts). Returns null
 * for anything that isn't an initialized SPL token account, so callers can treat it as "not closable".
 */
export function parseTokenAccount(address: PublicKey, account: { lamports: number; owner: PublicKey; data: unknown } | null): TokenAccount | null {
  const data = account?.data as { program?: string; parsed?: { type?: string; info?: any } } | undefined;
  if (!account || !data || typeof data !== "object" || Buffer.isBuffer(data)) return null;
  const program = PROGRAMS[data.program ?? ""];
  if (!program || !account.owner.equals(program) || data.parsed?.type !== "account") return null;
  const info = data.parsed.info;
  if (!info || info.state === "uninitialized") return null;
  try {
    const native = !!info.isNative;
    const rentLamports = native ? Number(info.rentExemptReserve?.amount ?? 0) : account.lamports;
    const ext = Array.isArray(info.extensions) ? info.extensions.find((e: any) => e?.extension === "transferFeeAmount") : null;
    return {
      address,
      owner: String(info.owner),
      mint: String(info.mint),
      tokenProgram: program,
      rawAmount: BigInt(info.tokenAmount.amount),
      decimals: Number(info.tokenAmount.decimals),
      uiAmount: Number(info.tokenAmount.uiAmountString),
      frozen: info.state === "frozen",
      native,
      lamports: account.lamports,
      rentLamports: Number.isFinite(rentLamports) ? rentLamports : account.lamports,
      closeAuthority: typeof info.closeAuthority === "string" ? info.closeAuthority : null,
      withheld: BigInt(ext?.state?.withheldAmount ?? 0),
    };
  } catch {
    return null;
  }
}

export async function getTokenAccounts(connection: Connection, owner: PublicKey): Promise<TokenAccount[]> {
  const out: TokenAccount[] = [];
  const reads = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => connection.getParsedTokenAccountsByOwner(owner, { programId })));
  for (const { value } of reads)
    for (const { pubkey, account } of value) {
      const a = parseTokenAccount(pubkey, account);
      if (a) out.push(a);
    }
  return out;
}
