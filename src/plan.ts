import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { JupiterError, getBuild, type BuildResponse, type PriceInfo } from "./jupiter.js";
import { NO_SOL, buildOne, fitsOne, type Batch, type FeeLeg, type SwapLeg } from "./pack.js";
import type { Holding } from "./wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
/** Account caps for the dust swap, loosest first: looser routes usually price better but make bigger transactions. */
const DUST_CAPS = [64, 48, 40, 32, 24, 20];
/**
 * Account caps for the buy-and-burn swap, tightest first, so it leaves the most room for the dust swap. A pump.fun
 * AMM pool (where $LILVADER trades) takes 28 accounts from SOL, and two hops (40) from USDC or USDT; a tighter cap
 * only spends a rate-limited quote on "no route".
 */
const FEE_CAPS = [28, 32, 40, 48, 64];
/** Skip reasons the UI maps to a retry or an explanation. */
const BUSY = "quote service busy; try again shortly";
const TOO_LARGE = "route too large to fit in one transaction with its buy-and-burn";

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

// Remembered across requests on a warm instance, so a preview split into several requests doesn't pay for the
// same discovery twice: the tightest fee cap that routed, and a recent fee quote that smaller fees can scale from.
const feeCapMemo = new Map<string, number>();
const feeTemplates = new Map<string, { build: BuildResponse; amountIn: bigint; at: number }>();
const TEMPLATE_TTL_MS = 15_000;

/** Byte offsets of in_amount and quoted_out_amount in Jupiter's v2 route instruction data. */
const IN_AT = 8;
const OUT_AT = 16;

/**
 * Re-size a fee quote to a smaller input. On an AMM a smaller trade never gets a worse average price, so scaling
 * the quoted output down linearly (minus a 0.5% margin) is conservative; the swap's own slippage check and the
 * simulation still guard it. Returns null when the instruction isn't the layout we know, so callers quote exactly.
 */
function scaleFee(t: BuildResponse, tAmount: bigint, amountIn: bigint, slippageBps: number): BuildResponse | null {
  if (amountIn > tAmount || amountIn <= 0n) return null;
  const data = Buffer.from(t.swapInstruction.data, "base64");
  if (data.length < OUT_AT + 8 || data.readBigUInt64LE(IN_AT) !== BigInt(t.inAmount) || data.readBigUInt64LE(OUT_AT) !== BigInt(t.outAmount)) return null;
  const out = (BigInt(t.outAmount) * amountIn * 995n) / (tAmount * 1000n);
  if (out === 0n) return null;
  const d = Buffer.from(data);
  d.writeBigUInt64LE(amountIn, IN_AT);
  d.writeBigUInt64LE(out, OUT_AT);
  return {
    ...t,
    inAmount: amountIn.toString(),
    outAmount: out.toString(),
    otherAmountThreshold: ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
    swapInstruction: { ...t.swapInstruction, data: d.toString("base64") },
  };
}

interface FeeKit {
  /** Fee leg for these swaps: scaled from the batch's fee quote when possible, quoted exactly when `exact`. */
  forLegs(legs: SwapLeg[], opts?: { exact?: boolean }): Promise<FeeLeg | null>;
  /** Make sure a fresh fee quote at least this large exists, so every fee in the batch can scale from it. */
  prepare(maxAmountIn: bigint): Promise<void>;
}

export async function makeFeeKit(o: PlanOptions): Promise<FeeKit> {
  const fee = o.fee;
  if (!feeApplies(fee, o.outMint)) return { forLegs: async () => null, prepare: async () => {} };
  const mint = new PublicKey(fee.burnMint);
  const info = await o.connection.getAccountInfo(mint);
  if (!info) throw new Error("burn token mint not found on-chain");
  const tokenProgram = info.owner;
  const { decimals } = await getMint(o.connection, mint, "confirmed", tokenProgram);
  const account = getAssociatedTokenAddressSync(mint, o.owner, false, tokenProgram);
  const memoKey = `${o.outMint}>${fee.burnMint}`;
  // Into SOL the fee is one hop; from anything else it needs a second one, so start where that fits.
  const caps = o.outMint === SOL_MINT ? FEE_CAPS : FEE_CAPS.filter((c) => c >= 40);
  const tplKey = `${memoKey}@${o.owner.toBase58()}`; // fee quotes carry the taker's accounts
  const leg = (build: BuildResponse, amountIn: bigint): FeeLeg =>
    // Burn the minimum the swap guarantees; any extra from positive slippage stays with the user.
    ({ build, amountIn, burn: { mint, account, amount: BigInt(build.otherAmountThreshold), decimals, tokenProgram } });

  const quote = async (amountIn: bigint): Promise<BuildResponse> => {
    let last: unknown;
    for (let i = feeCapMemo.get(memoKey) ?? 0; i < caps.length; i++) {
      try {
        const build = await getBuild(o.apiKey, {
          inputMint: o.outMint,
          outputMint: fee.burnMint,
          amount: amountIn.toString(),
          taker: o.owner.toBase58(),
          slippageBps: fee.slippageBps,
          maxAccounts: caps[i],
        });
        feeCapMemo.set(memoKey, i);
        return build;
      } catch (e) {
        if (e instanceof JupiterError && e.busy) throw e; // a wider route won't help while Jupiter is busy
        last = e;
      }
    }
    feeCapMemo.delete(memoKey); // routes change; start from the tightest cap next time
    throw last;
  };
  const freshTemplate = (atLeast: bigint) => {
    const t = feeTemplates.get(tplKey);
    return t && Date.now() - t.at < TEMPLATE_TTL_MS && t.amountIn >= atLeast ? t : null;
  };
  let pending: Promise<void> | null = null;

  return {
    async prepare(maxAmountIn) {
      if (maxAmountIn <= 0n || freshTemplate(maxAmountIn)) return;
      pending ??= quote(maxAmountIn).then((build) => {
        if (feeTemplates.size > 500) feeTemplates.clear();
        feeTemplates.set(tplKey, { build, amountIn: maxAmountIn, at: Date.now() });
      }).finally(() => (pending = null));
      await pending;
    },
    async forLegs(legs, { exact = false } = {}) {
      const amountIn = feeAmount(legs, fee.bps);
      if (amountIn === 0n) return null; // too small to charge anything
      if (!exact) {
        const t = freshTemplate(amountIn);
        const scaled = t && scaleFee(t.build, t.amountIn, amountIn, fee.slippageBps);
        if (scaled) return leg(scaled, amountIn);
      }
      return leg(await quote(amountIn), amountIn);
    },
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
  const kit = await makeFeeKit(o);
  const recent = blockhashCache(o.connection);
  // Into SOL both swaps share the SOL leg and the widest routes fit; into anything else the fee needs a second hop,
  // so start one size tighter instead of paying for a quote that almost never fits.
  const widest = o.fee && feeApplies(o.fee, o.outMint) && o.outMint !== SOL_MINT ? 48 : 64;
  const caps = DUST_CAPS.filter((c) => c <= Math.min(o.maxAccounts, widest));
  if (!caps.length) caps.push(o.maxAccounts);
  const pool = async <T>(items: T[], fn: (x: T) => Promise<unknown>) => {
    const queue = [...items];
    await Promise.all(Array.from({ length: 3 }, async () => { for (let x; (x = queue.shift()) !== undefined; ) await fn(x); }));
  };

  // Quote one dust swap at a given cap, or say why it can't be sold.
  const quoteDust = async (c: (typeof o.items)[number], cap: number): Promise<SwapLeg | string> => {
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
      console.error(`no route for ${c.h.mint} at maxAccounts=${cap}: ${(e as Error).message.slice(0, 300)}`);
      // Jupiter being busy or down says nothing about the token's market.
      return e instanceof JupiterError && e.busy ? BUSY : `no route: ${(e as Error).message.slice(0, 120)}`;
    }
    const outUsd = (Number(leg.build.outAmount) / 10 ** o.outInfo.decimals) * o.outInfo.usdPrice;
    if (outUsd < c.usd * (1 - o.maxLoss))
      return `route returns $${outUsd.toFixed(4)} for $${c.usd.toFixed(4)} (> ${Math.round(o.maxLoss * 100)}% loss)`;
    return leg;
  };

  // 1. Quote every swap at the widest cap (usually the best price).
  const quoted: { c: (typeof o.items)[number]; leg: SwapLeg }[] = [];
  await pool(o.items, async (c) => {
    const leg = await quoteDust(c, caps[0]);
    if (typeof leg === "string") skipped.push({ mint: c.h.mint, reason: leg });
    else quoted.push({ c, leg });
  });

  // 2. One fee quote for the largest fee in the batch; every other fee scales down from it.
  if (quoted.length && o.fee) {
    const max = quoted.reduce((m, q) => { const a = feeAmount([q.leg], o.fee!.bps); return a > m ? a : m; }, 0n);
    try {
      await kit.prepare(max);
    } catch (e) {
      // Never swap without the fee when one applies.
      console.error(`fee route failed: ${(e as Error).message.slice(0, 300)}`);
      for (const q of quoted) skipped.push({ mint: q.c.h.mint, reason: "buy-and-burn fee couldn't be routed right now; try again shortly" });
      return { batches, skipped };
    }
  }

  // 3. Fit each swap with its own buy-and-burn (tightening the route only if needed), then simulate.
  await pool(quoted, async ({ c, leg: first }) => {
    let leg: SwapLeg = first;
    for (let i = 0; i < caps.length; i++) {
      if (i > 0) {
        const tighter = await quoteDust(c, caps[i]);
        // It has a market (it routed wider), just no route small enough to fit next to its buy-and-burn.
        if (typeof tighter === "string") return skipped.push({ mint: c.h.mint, reason: tighter.startsWith("no route") ? TOO_LARGE : tighter });
        leg = tighter;
      }
      let fee: FeeLeg | null;
      try {
        fee = await kit.forLegs([leg]);
      } catch (e) {
        console.error(`fee route failed for ${c.h.mint}: ${(e as Error).message.slice(0, 300)}`);
        return skipped.push({ mint: c.h.mint, reason: "buy-and-burn fee couldn't be routed right now; try again shortly" });
      }
      if (!fitsOne(o.owner, leg, fee, o.closeSource)) continue;
      let r = await buildOne(o.connection, o.owner, leg, fee, o.closeSource, await recent());
      if ("error" in r && fee && r.error !== NO_SOL) {
        // A scaled fee that doesn't simulate gets one exact quote before the token is given up on (not when the
        // wallet is short of SOL: no quote changes that).
        try {
          const exact = await kit.forLegs([leg], { exact: true });
          if (fitsOne(o.owner, leg, exact, o.closeSource)) r = await buildOne(o.connection, o.owner, leg, exact, o.closeSource, await recent());
        } catch {}
      }
      if ("batch" in r) return batches.push(r.batch);
      if ("error" in r) return skipped.push({ mint: c.h.mint, reason: r.error });
    }
    skipped.push({ mint: c.h.mint, reason: TOO_LARGE });
  });

  // Keep the order the user saw.
  const order = new Map(o.items.map((c, i) => [c.h.mint, i]));
  batches.sort((a, b) => order.get(a.legs[0].holding.mint)! - order.get(b.legs[0].holding.mint)!);
  return { batches, skipped };
}
