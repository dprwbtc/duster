import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { getBuild as getBuildOnce, type PriceInfo } from "./jupiter.js";
import { feeOnlyBatch, finalize, groupBySize, type Batch, type FeeBuilder, type FeeLeg, type SwapLeg } from "./pack.js";
import type { Holding } from "./wallet.js";

/** Account caps to try, tightest first: a tight cap packs more swaps per transaction but hides many routes. */
const ACCOUNT_CAPS = [20, 30, 40, 50, 64];

/** Try each account cap from the requested one upward; the smallest cap that routes gives the smallest transaction. */
async function getBuild(apiKey: string, p: Parameters<typeof getBuildOnce>[1]) {
  const caps = ACCOUNT_CAPS.filter((c) => c >= p.maxAccounts);
  let last: unknown;
  for (const maxAccounts of caps) {
    try {
      return await getBuildOnce(apiKey, { ...p, maxAccounts });
    } catch (e) {
      last = e;
      console.warn(`build ${p.inputMint} -> ${p.outputMint} failed at maxAccounts=${maxAccounts}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  throw last;
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
  const { groups, overflow } = groupBySize(o.owner, legs, o.closeSource, reserve);
  const batches = (await Promise.all(groups.map((g) => finalize(o.connection, o.owner, g, o.closeSource, feeFor, skipped)))).flat();

  if (overflow.length) {
    // These swaps are too large to share a transaction with the fee. Swap them on their own, then settle
    // their fee in one extra transaction at the end (the wallet still approves everything in a single prompt).
    const noFee: FeeBuilder = async () => null;
    const keepBurnAccount = overflow.some((l) => l.holding.mint === o.fee?.burnMint);
    const close = o.closeSource && !keepBurnAccount;
    const { groups: og, overflow: tooBig } = groupBySize(o.owner, overflow, close, null);
    for (const l of tooBig) skipped.push({ mint: l.holding.mint, reason: "route too large to fit in a transaction" });
    const extra = (await Promise.all(og.map((g) => finalize(o.connection, o.owner, g, close, noFee, skipped)))).flat();
    batches.push(...extra);
    const swapped = extra.flatMap((b) => b.legs);
    if (swapped.length && feeApplies(o.fee, o.outMint)) {
      try {
        const fee = await feeFor(swapped);
        const feeTx = fee && (await feeOnlyBatch(o.connection, o.owner, fee));
        if (fee && !feeTx) throw new Error("fee transaction too large");
        if (feeTx) batches.push(feeTx);
      } catch (e) {
        // Never swap without the fee when one applies: drop the swaps that needed it.
        console.error(`overflow fee failed: ${(e as Error).message.slice(0, 300)}`);
        const drop = new Set(extra);
        for (let i = batches.length - 1; i >= 0; i--) if (drop.has(batches[i])) batches.splice(i, 1);
        for (const l of swapped) skipped.push({ mint: l.holding.mint, reason: "buy-and-burn fee couldn't be routed right now; try again shortly" });
      }
    }
  }
  return { batches, skipped };
}
