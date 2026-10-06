import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { getBuild, type PriceInfo } from "./jupiter.js";
import { buildOne, fitsOne, type Batch, type FeeBuilder, type FeeLeg, type SwapLeg } from "./pack.js";
import type { Holding } from "./wallet.js";

/** Account caps for the dust swap, loosest first: looser routes usually price better but make bigger transactions. */
const DUST_CAPS = [64, 48, 40, 32, 24, 20];
/** Account caps for the buy-and-burn swap, tightest first, so it leaves the most room for the dust swap. */
const FEE_CAPS = [24, 32, 40, 48, 64];

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
  maxAccounts: number; // largest route size to try for each dust swap
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
  // Remember the tightest cap that routed, so later tokens in the plan don't retry caps that can't work.
  let start = 0;
  return async (legs): Promise<FeeLeg | null> => {
    const amountIn = feeAmount(legs, fee.bps);
    if (amountIn === 0n) return null; // too small to charge anything
    let last: unknown;
    for (let i = start; i < FEE_CAPS.length; i++) {
      try {
        const build = await getBuild(o.apiKey, {
          inputMint: o.outMint,
          outputMint: fee.burnMint,
          amount: amountIn.toString(),
          taker: o.owner.toBase58(),
          slippageBps: fee.slippageBps,
          maxAccounts: FEE_CAPS[i],
        });
        start = i;
        // Burn the minimum the swap guarantees; any extra from positive slippage stays with the user.
        return { build, amountIn, burn: { mint, account, amount: BigInt(build.otherAmountThreshold), decimals, tokenProgram } };
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
}

/** Blockhashes last ~60s; share one across tokens planned close together, but don't let it go stale. */
function blockhashCache(connection: Connection) {
  let cached: { at: number; value: Promise<{ blockhash: string; lastValidBlockHeight: number }> } | null = null;
  return () => {
    if (!cached || Date.now() - cached.at > 10_000) cached = { at: Date.now(), value: connection.getLatestBlockhash("confirmed") };
    return cached.value;
  };
}

/**
 * Build one transaction per token: its swap plus its own buy-and-burn, so the fee is atomic with the swap.
 * The wallet signs them all in one prompt. Returns unsigned, simulated batches and the tokens that were skipped.
 */
export async function planSwaps(o: PlanOptions): Promise<{ batches: Batch[]; skipped: Skipped[] }> {
  const skipped: Skipped[] = [];
  const batches: Batch[] = [];
  const feeFor: FeeBuilder = await makeFeeBuilder(o);
  const recent = blockhashCache(o.connection);
  const caps = DUST_CAPS.filter((c) => c <= o.maxAccounts);
  if (!caps.length) caps.push(o.maxAccounts);
  const queue = [...o.items];

  const planOne = async (c: (typeof o.items)[number]) => {
    let feeProbe: FeeLeg | null | undefined; // last fee leg built, reused to size-check tighter routes cheaply
    for (const cap of caps) {
      let leg: SwapLeg;
      try {
        const build = await getBuild(o.apiKey, {
          inputMint: c.h.mint,
          outputMint: o.outMint,
          amount: c.h.rawAmount.toString(),
          taker: o.owner.toBase58(),
          slippageBps: o.slippageBps,
          maxAccounts: cap,
        });
        leg = { holding: c.h, build, usdIn: c.usd };
      } catch (e) {
        // Tighter caps only remove routes, so there's no point retrying lower.
        console.error(`no route for ${c.h.mint} at maxAccounts=${cap}: ${(e as Error).message.slice(0, 300)}`);
        return skipped.push({ mint: c.h.mint, reason: `no route: ${(e as Error).message.slice(0, 120)}` });
      }
      const outUsd = (Number(leg.build.outAmount) / 10 ** o.outInfo.decimals) * o.outInfo.usdPrice;
      if (outUsd < c.usd * (1 - o.maxLoss))
        return skipped.push({ mint: c.h.mint, reason: `route returns $${outUsd.toFixed(4)} for $${c.usd.toFixed(4)} (> ${Math.round(o.maxLoss * 100)}% loss)` });
      if (feeProbe !== undefined && !fitsOne(o.owner, leg, feeProbe, o.closeSource)) continue;

      let fee: FeeLeg | null;
      try {
        fee = feeProbe = await feeFor([leg]);
      } catch (e) {
        // Never swap without the fee when one applies.
        console.error(`fee route failed for ${c.h.mint}: ${(e as Error).message.slice(0, 300)}`);
        return skipped.push({ mint: c.h.mint, reason: "buy-and-burn fee couldn't be routed right now; try again shortly" });
      }
      const r = await buildOne(o.connection, o.owner, leg, fee, o.closeSource, await recent());
      if ("batch" in r) return batches.push(r.batch);
      if ("error" in r) return skipped.push({ mint: c.h.mint, reason: r.error });
    }
    skipped.push({ mint: c.h.mint, reason: "route too large to fit in one transaction with its buy-and-burn" });
  };

  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let c; (c = queue.shift()); ) await planOne(c);
    }),
  );
  // Keep the order the user saw.
  const order = new Map(o.items.map((c, i) => [c.h.mint, i]));
  batches.sort((a, b) => order.get(a.legs[0].holding.mint)! - order.get(b.legs[0].holding.mint)!);
  return { batches, skipped };
}
