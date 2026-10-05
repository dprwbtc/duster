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
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId });
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
