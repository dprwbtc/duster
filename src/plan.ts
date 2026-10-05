import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { getBuild as getBuildOnce, type PriceInfo } from "./jupiter.js";
import { finalize, groupBySize, type Batch, type FeeBuilder, type FeeLeg, type SwapLeg } from "./pack.js";
import type { Holding } from "./wallet.js";

/** Loosest account cap Jupiter allows; a tight cap packs more swaps per transaction but hides many routes. */
const WIDE_MAX_ACCOUNTS = 64;

/** Try the requested account cap first, then retry once with a wide cap before giving up on a route. */
async function getBuild(apiKey: string, p: Parameters<typeof getBuildOnce>[1]) {
  try {
    return await getBuildOnce(apiKey, p);
  } catch (e) {
    if (p.maxAccounts >= WIDE_MAX_ACCOUNTS) throw e;
    console.warn(`build ${p.inputMint} -> ${p.outputMint} failed at maxAccounts=${p.maxAccounts}, retrying wide: ${(e as Error).message.slice(0, 200)}`);
    return getBuildOnce(apiKey, { ...p, maxAccounts: WIDE_MAX_ACCOUNTS });
  }
}

/** Buy-and-burn fee: `bps` of each transaction's guaranteed output buys `burnMint`, which is then burned. */
export interface FeeConfig {
  bps: number;
  burnMint: string;
  slippageBps: number;
}

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
  fee?: FeeConfig | null;
}

export interface Skipped {
  mint: string;
  reason: string;
}

/** No fee when the user is already swapping into the burn token. */
export const feeApplies = (fee: FeeConfig | null | undefined, outMint: string): fee is FeeConfig =>
  !!fee && fee.bps > 0 && fee.burnMint !== outMint;

/** Fee is charged on the minimum guaranteed output, so it can never exceed `bps` of what the user receives. */
export const feeAmount = (legs: SwapLeg[], bps: number) =>
  (legs.reduce((s, l) => s + BigInt(l.build.otherAmountThreshold), 0n) * BigInt(bps)) / 10_000n;

async function makeFeeBuilder(o: PlanOptions): Promise<FeeBuilder> {
  const fee = o.fee;
  if (!feeApplies(fee, o.outMint)) return async () => null;
  const mint = new PublicKey(fee.burnMint);
  const info = await o.connection.getAccountInfo(mint);
  if (!info) throw new Error("burn token mint not found on-chain");
  const tokenProgram = info.owner;
  const { decimals } = await getMint(o.connection, mint, "confirmed", tokenProgram);
  const account = getAssociatedTokenAddressSync(mint, o.owner, false, tokenProgram);
  return async (legs): Promise<FeeLeg | null> => {
    const amountIn = feeAmount(legs, fee.bps);
    if (amountIn === 0n) return null; // too small to charge anything
    const build = await getBuild(o.apiKey, {
      inputMint: o.outMint,
      outputMint: fee.burnMint,
      amount: amountIn.toString(),
      taker: o.owner.toBase58(),
      slippageBps: fee.slippageBps,
      maxAccounts: o.maxAccounts,
    });
    // Burn the minimum the swap guarantees; any extra from positive slippage stays with the user.
    return { build, amountIn, burn: { mint, account, amount: BigInt(build.otherAmountThreshold), decimals, tokenProgram } };
  };
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
          console.error(`no route for ${c.h.mint}: ${(e as Error).message.slice(0, 300)}`);
          skipped.push({ mint: c.h.mint, reason: `no route: ${(e as Error).message.slice(0, 120)}` });
        }
      }
    }),
  );
  if (!legs.length) return { batches: [], skipped };

  const feeFor = await makeFeeBuilder(o);
  // Quote the fee once on everything so packing leaves room for each transaction's buy-and-burn.
  let reserve: FeeLeg | null;
  try {
    reserve = await feeFor(legs);
  } catch (e) {
    console.error(`fee route failed: ${(e as Error).message.slice(0, 300)}`);
    for (const l of legs) skipped.push({ mint: l.holding.mint, reason: "buy-and-burn fee couldn't be routed right now; try again shortly" });
    return { batches: [], skipped };
  }
  const groups = groupBySize(o.owner, legs, o.closeSource, reserve);
  const batches = (await Promise.all(groups.map((g) => finalize(o.connection, o.owner, g, o.closeSource, feeFor, skipped)))).flat();
  return { batches, skipped };
}
