import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { ApiInstruction, BuildResponse } from "./jupiter.js";
import type { Holding } from "./wallet.js";

const MAX_TX_BYTES = 1232;
const MAX_ACCOUNT_LOCKS = 64; // the network rejects transactions that touch more accounts than this
const CU_MAX = 1_400_000;
const SET_COMPUTE_UNIT_PRICE = 3;
// Priority fee bounds in micro-lamports per compute unit. Jupiter's estimate can be too low to land before the
// blockhash expires; at ~300k CU the floor costs ~0.000015 SOL and the cap ~0.00009 SOL per transaction.
const MIN_CU_PRICE = 50_000;
const MAX_CU_PRICE = 300_000;

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

/** Builds the fee leg for a swap, or returns null when no fee applies. Throws if the fee can't be routed. */
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
function swapInstructions(build: BuildResponse, seenSetup: Set<string>, state: { closed: boolean }, payer: PublicKey): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  // An earlier swap's cleanup closes the wrapped-SOL account, but Jupiter leaves out the create when that account
  // already exists on-chain, so a later swap in or out of SOL would hit a closed account. Recreate it (no-op if present).
  const wsol = NATIVE_MINT.toBase58();
  if (state.closed && (build.inputMint === wsol || build.outputMint === wsol))
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(NATIVE_MINT, payer), payer, NATIVE_MINT));
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
    body.push(...swapInstructions(build, seen, state, payer));
    // Full balance was swapped, so the now-empty token account can be closed to reclaim its rent
    // (except the burn token's, which the fee leg below still needs).
    if (closeSource && holding.mint !== burnMint) body.push(createCloseAccountInstruction(holding.account, payer, payer, [], holding.tokenProgram));
  }
  if (fee) {
    // Runs after the dust swaps, so it spends output the user has just received in this same transaction.
    body.push(...swapInstructions(fee.build, seen, state, payer));
    const b = fee.burn;
    if (b.amount > 0n) body.push(createBurnCheckedInstruction(b.account, b.mint, payer, b.amount, b.decimals, [], b.tokenProgram));
  }
  // Use Jupiter's priority-fee estimate within our bounds, and set our own CU limit.
  let microLamports = MIN_CU_PRICE;
  for (const b of [...legs.map((l) => l.build), ...(fee ? [fee.build] : [])])
    for (const i of b.computeBudgetInstructions) {
      const d = Buffer.from(i.data, "base64");
      if (d[0] === SET_COMPUTE_UNIT_PRICE && d.length >= 9) microLamports = Math.max(microLamports, Number(d.readBigUInt64LE(1)));
    }
  const price = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.min(microLamports, MAX_CU_PRICE) })];
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
    const m = tx.message;
    const loaded = m.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
    if (m.staticAccountKeys.length + loaded > MAX_ACCOUNT_LOCKS) return false;
    return tx.serialize().length <= MAX_TX_BYTES;
  } catch {
    return false; // serialization throws when the message is too large
  }
}

/** Whether a token's swap, account close and buy-and-burn fit together in one transaction. */
export function fitsOne(payer: PublicKey, leg: SwapLeg, fee: FeeLeg | null, closeSource: boolean): boolean {
  return fits(compile(payer, [leg], fee, closeSource, CU_MAX, PublicKey.default.toBase58()));
}

export type BuildResult = { batch: Batch } | { tooLarge: true } | { error: string };

/**
 * One token per transaction: its swap, the close of its emptied account, and its own buy-and-burn, so the
 * fee is atomic with the swap. Simulates to size the compute budget. Unsigned.
 */
export async function buildOne(
  connection: Connection,
  payer: PublicKey,
  leg: SwapLeg,
  fee: FeeLeg | null,
  closeSource: boolean,
  recent: { blockhash: string; lastValidBlockHeight: number },
): Promise<BuildResult> {
  const { blockhash, lastValidBlockHeight } = recent;
  if (!fits(compile(payer, [leg], fee, closeSource, CU_MAX, blockhash))) return { tooLarge: true };
  const simulate = async (close: boolean) =>
    (await connection.simulateTransaction(compile(payer, [leg], fee, close, CU_MAX, blockhash), { replaceRecentBlockhash: true, sigVerify: false })).value;
  let close = closeSource;
  let sim = await simulate(close);
  // Some accounts can't be closed (e.g. Token-2022 with withheld transfer fees): keep the account rather than lose the swap.
  if (sim.err && close) sim = await simulate((close = false));
  if (sim.err) return { error: `simulation failed: ${JSON.stringify(sim.err)}` };
  const limit = sim.unitsConsumed ? Math.min(Math.ceil(sim.unitsConsumed * 1.2), CU_MAX) : CU_MAX;
  return { batch: { legs: [leg], fee, tx: compile(payer, [leg], fee, close, limit, blockhash), blockhash, lastValidBlockHeight } };
}
