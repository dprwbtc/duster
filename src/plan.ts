import { Connection, PublicKey } from "@solana/web3.js";
import { getBuild, type PriceInfo } from "./jupiter.js";
import { finalize, groupBySize, type Batch, type SwapLeg } from "./pack.js";
import type { Holding } from "./wallet.js";

export interface PlanOptions {
  connection: Connection;
  apiKey: string;
  owner: PublicKey;
  outMint: string;
  outInfo: PriceInfo;
  items: { h: Holding; usd: number }[];
  slippageBps: number;
  maxAccounts: number;
  maxLoss: number; // fraction, e.g. 0.1
  closeSource: boolean;
}

export interface Skipped {
  mint: string;
  reason: string;
}

/** Quote each token, drop bad routes, pack into transactions, simulate. Returns unsigned batches. */
export async function planSwaps(o: PlanOptions): Promise<{ batches: Batch[]; skipped: Skipped[] }> {
  const skipped: Skipped[] = [];
  const legs: SwapLeg[] = [];
  const queue = [...o.items];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let c; (c = queue.shift()); ) {
        try {
          const build = await getBuild(o.apiKey, {
            inputMint: c.h.mint,
            outputMint: o.outMint,
            amount: c.h.rawAmount.toString(),
            taker: o.owner.toBase58(),
            slippageBps: o.slippageBps,
            maxAccounts: o.maxAccounts,
          });
          const outUsd = (Number(build.outAmount) / 10 ** o.outInfo.decimals) * o.outInfo.usdPrice;
          if (outUsd < c.usd * (1 - o.maxLoss)) {
            skipped.push({ mint: c.h.mint, reason: `route returns $${outUsd.toFixed(4)} for $${c.usd.toFixed(4)} (> ${Math.round(o.maxLoss * 100)}% loss)` });
            continue;
          }
          legs.push({ holding: c.h, build, usdIn: c.usd });
        } catch (e) {
          skipped.push({ mint: c.h.mint, reason: `no route: ${(e as Error).message.slice(0, 120)}` });
        }
      }
    }),
  );
  const groups = groupBySize(o.owner, legs, o.closeSource);
  const batches = (await Promise.all(groups.map((g) => finalize(o.connection, o.owner, g, o.closeSource, skipped)))).flat();
  return { batches, skipped };
}
