import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createBurnCheckedInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import type { ApiInstruction, BuildResponse } from "./jupiter.js";
import type { Holding } from "./wallet.js";

const MAX_TX_BYTES = 1232;
const CU_MAX = 1_400_000;
const SET_COMPUTE_UNIT_PRICE = 3;

export interface SwapLeg {
  holding: Holding;
  build: BuildResponse;
  usdIn: number;
}

/** Buy-and-burn appended to a transaction: swap part of the output into the burn token, then burn it. */
export interface FeeLeg {
  build: BuildResponse;
  amountIn: bigint; // in output-token base units
  burn: { mint: PublicKey; account: PublicKey; amount: bigint; decimals: number; tokenProgram: PublicKey };
}

/** Builds the fee leg for a group of swaps, or returns null when no fee applies. Throws if the fee can't be routed. */
export type FeeBuilder = (legs: SwapLeg[]) => Promise<FeeLeg | null>;

export interface Batch {
  legs: SwapLeg[];
  fee: FeeLeg | null;
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

export function toIx(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

function toAlts(raw: Record<string, string[]> | null): AddressLookupTableAccount[] {
  if (!raw) return [];
  return Object.entries(raw).map(
    ([key, addrs]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: addrs.map((a) => new PublicKey(a)),
        },
      }),
  );
}

const ixKey = (ix: ApiInstruction) => JSON.stringify([ix.programId, ix.accounts, ix.data]);

/** A Jupiter swap's instructions, in order. Setup ixs already emitted earlier in the transaction are dropped. */
function swapInstructions(build: BuildResponse, seenSetup: Set<string>, state: { closed: boolean }): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  for (const s of build.setupInstructions) {
    const k = ixKey(s);
    // Only dedupe if no cleanup (e.g. WSOL close) has run yet, otherwise the account may be gone.
    if (!state.closed && seenSetup.has(k)) continue;
    seenSetup.add(k);
    ixs.push(toIx(s));
  }
  ixs.push(toIx(build.swapInstruction));
  if (build.cleanupInstruction) {
    ixs.push(toIx(build.cleanupInstruction));
    state.closed = true;
  }
  for (const o of build.otherInstructions) ixs.push(toIx(o));
  return ixs;
}

function compile(
  payer: PublicKey,
  legs: SwapLeg[],
  fee: FeeLeg | null,
  closeSource: boolean,
  cuLimit: number,
  blockhash: string,
): VersionedTransaction {
  const seen = new Set<string>();
  const state = { closed: false };
  const body: TransactionInstruction[] = [];
  const burnMint = fee?.burn.mint.toBase58();
  for (const { build, holding } of legs) {
    body.push(...swapInstructions(build, seen, state));
    // Full balance was swapped, so the now-empty token account can be closed to reclaim its rent
    // (except the burn token's, which the fee leg below still needs).
    if (closeSource && holding.mint !== burnMint) body.push(createCloseAccountInstruction(holding.account, payer, payer, [], holding.tokenProgram));
  }
  if (fee) {
    // Runs after the dust swaps, so it spends output the user has just received in this same transaction.
    body.push(...swapInstructions(fee.build, seen, state));
    const b = fee.burn;
    if (b.amount > 0n) body.push(createBurnCheckedInstruction(b.account, b.mint, payer, b.amount, b.decimals, [], b.tokenProgram));
  }
  // Keep Jupiter's priority-fee instruction (from the first leg) but set our own CU limit.
  const price = legs[0].build.computeBudgetInstructions.filter((i) => Buffer.from(i.data, "base64")[0] === SET_COMPUTE_UNIT_PRICE).map(toIx);
  const alts = new Map<string, AddressLookupTableAccount>();
  for (const b of [...legs.map((l) => l.build), ...(fee ? [fee.build] : [])])
    for (const a of toAlts(b.addressesByLookupTableAddress)) alts.set(a.key.toBase58(), a);
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...price, ...body],
  }).compileToV0Message([...alts.values()]);
  return new VersionedTransaction(msg);
}

function fits(tx: VersionedTransaction): boolean {
  try {
    return tx.serialize().length <= MAX_TX_BYTES;
  } catch {
    return false; // serialization throws when the message is too large
  }
}

/**
 * Greedily group legs so every group fits in a single transaction (1232 bytes).
 * `reserve` is a representative fee leg, so each group leaves room for its own buy-and-burn.
 */
export function groupBySize(payer: PublicKey, legs: SwapLeg[], closeSource: boolean, reserve: FeeLeg | null): SwapLeg[][] {
  const groups: SwapLeg[][] = [];
  let cur: SwapLeg[] = [];
  const dummy = PublicKey.default.toBase58();
  const ok = (g: SwapLeg[]) => fits(compile(payer, g, reserve, closeSource, CU_MAX, dummy));
  for (const leg of legs) {
    if (ok([...cur, leg])) {
      cur = [...cur, leg];
    } else {
      if (cur.length) groups.push(cur);
      cur = ok([leg]) ? [leg] : [];
      if (!cur.length) console.warn(`  ! ${leg.holding.mint} alone does not fit in a transaction; skipping`);
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Attach the group's fee leg, check size, and simulate to size the compute budget. If anything fails,
 * bisect so one bad token (no route, frozen, etc.) doesn't sink the others. Returns unsigned batches.
 */
export async function finalize(
  connection: Connection,
  payer: PublicKey,
  legs: SwapLeg[],
  closeSource: boolean,
  feeFor: FeeBuilder,
  skipped: { mint: string; reason: string }[],
): Promise<Batch[]> {
  if (legs.length === 0) return [];
  const split = async (reason: string) => {
    if (legs.length === 1) {
      skipped.push({ mint: legs[0].holding.mint, reason });
      return [];
    }
    const mid = Math.ceil(legs.length / 2);
    return [
      ...(await finalize(connection, payer, legs.slice(0, mid), closeSource, feeFor, skipped)),
      ...(await finalize(connection, payer, legs.slice(mid), closeSource, feeFor, skipped)),
    ];
  };

  let fee: FeeLeg | null;
  try {
    fee = await feeFor(legs);
  } catch {
    // Never swap without the fee when one applies: if it can't be routed, the swaps don't go ahead.
    return split("buy-and-burn fee couldn't be routed right now; try again shortly");
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  if (!fits(compile(payer, legs, fee, closeSource, CU_MAX, blockhash))) return split("doesn't fit in a transaction");
  const sim = await connection.simulateTransaction(compile(payer, legs, fee, closeSource, CU_MAX, blockhash), {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  if (sim.value.err) return split(`simulation failed: ${JSON.stringify(sim.value.err)}`);
  const limit = sim.value.unitsConsumed ? Math.min(Math.ceil(sim.value.unitsConsumed * 1.2), CU_MAX) : CU_MAX;
  const tx = compile(payer, legs, fee, closeSource, limit, blockhash);
  return [{ legs, fee, tx, blockhash, lastValidBlockHeight }];
}
