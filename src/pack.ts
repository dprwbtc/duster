import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
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

export interface Batch {
  legs: SwapLeg[];
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

/** Instructions for one swap leg, in order. Setup ixs already emitted earlier in the batch are dropped. */
function legInstructions(leg: SwapLeg, owner: PublicKey, closeSource: boolean, seenSetup: Set<string>, state: { closed: boolean }): TransactionInstruction[] {
  const { build, holding } = leg;
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
  if (closeSource) {
    // Full balance was swapped, so the now-empty token account can be closed to reclaim its rent.
    ixs.push(createCloseAccountInstruction(holding.account, owner, owner, [], holding.tokenProgram));
  }
  return ixs;
}

function compile(
  payer: PublicKey,
  legs: SwapLeg[],
  closeSource: boolean,
  cuLimit: number,
  blockhash: string,
): VersionedTransaction {
  const seen = new Set<string>();
  const state = { closed: false };
  const body = legs.flatMap((l) => legInstructions(l, payer, closeSource, seen, state));
  // Keep Jupiter's priority-fee instruction (from the first leg) but set our own CU limit.
  const price = legs[0].build.computeBudgetInstructions.filter((i) => Buffer.from(i.data, "base64")[0] === SET_COMPUTE_UNIT_PRICE).map(toIx);
  const alts = new Map<string, AddressLookupTableAccount>();
  for (const l of legs) for (const a of toAlts(l.build.addressesByLookupTableAddress)) alts.set(a.key.toBase58(), a);
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

/** Greedily group legs so every group fits in a single transaction (1232 bytes). */
export function groupBySize(payer: PublicKey, legs: SwapLeg[], closeSource: boolean): SwapLeg[][] {
  const groups: SwapLeg[][] = [];
  let cur: SwapLeg[] = [];
  const dummy = PublicKey.default.toBase58();
  for (const leg of legs) {
    const trial = [...cur, leg];
    if (fits(compile(payer, trial, closeSource, CU_MAX, dummy))) {
      cur = trial;
    } else if (cur.length === 0) {
      console.warn(`  ! ${leg.holding.mint} alone does not fit in a transaction; skipping`);
    } else {
      groups.push(cur);
      cur = fits(compile(payer, [leg], closeSource, CU_MAX, dummy)) ? [leg] : [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Simulate a group to size the compute budget. If it fails, bisect so one bad token
 * (no route, frozen, etc.) doesn't sink the others. Returns unsigned batches (the caller signs).
 */
export async function finalize(
  connection: Connection,
  payer: PublicKey,
  legs: SwapLeg[],
  closeSource: boolean,
  skipped: { mint: string; reason: string }[],
): Promise<Batch[]> {
  if (legs.length === 0) return [];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const sim = await connection.simulateTransaction(compile(payer, legs, closeSource, CU_MAX, blockhash), {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  if (sim.value.err) {
    if (legs.length === 1) {
      skipped.push({ mint: legs[0].holding.mint, reason: `simulation failed: ${JSON.stringify(sim.value.err)}` });
      return [];
    }
    const mid = Math.ceil(legs.length / 2);
    return [
      ...(await finalize(connection, payer, legs.slice(0, mid), closeSource, skipped)),
      ...(await finalize(connection, payer, legs.slice(mid), closeSource, skipped)),
    ];
  }
  const limit = sim.value.unitsConsumed ? Math.min(Math.ceil(sim.value.unitsConsumed * 1.2), CU_MAX) : CU_MAX;
  const tx = compile(payer, legs, closeSource, limit, blockhash);
  if (!fits(tx)) throw new Error("internal: final transaction exceeds size limit");
  return [{ legs, tx, blockhash, lastValidBlockHeight }];
}
