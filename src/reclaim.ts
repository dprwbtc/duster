// "The cleanup": close token accounts to get their rent back (~0.00204 SOL each), optionally burning worthless
// dust first. Unlike a swap there's nothing to quote, so many accounts share one transaction: they're packed
// greedily up to the network's size and account-lock limits, every transaction is simulated, and an account
// that makes a simulation fail is isolated and skipped with a plain reason instead of sinking its neighbours.
// No fee is added: the whole rent goes back to the wallet that paid it.
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createBurnCheckedInstruction, createCloseAccountInstruction, createHarvestWithheldTokensToMintInstruction } from "@solana/spl-token";
import { CU_MAX, MAX_CU_PRICE, MIN_CU_PRICE, fits } from "./pack.js";
import type { TokenAccount } from "./wallet.js";

export interface ReclaimItem {
  acct: TokenAccount;
  action: "close" | "burn+close";
}

export interface ReclaimBatch {
  items: ReclaimItem[];
  tx: VersionedTransaction;
  cuLimit: number;
}

export interface ReclaimPlan {
  batches: ReclaimBatch[];
  skipped: { address: string; reason: string }[];
  blockhash: string;
  lastValidBlockHeight: number;
  cuPrice: number;
}

const MAX_SIMULATIONS = 80; // per request: bounds RPC work even if every account fails one by one
const SIM_LANES = 4;

function instructionsFor({ acct, action }: ReclaimItem, owner: PublicKey): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  const mint = new PublicKey(acct.mint);
  // Withheld transfer fees block closing a Token-2022 account. Harvesting moves them to the mint (anyone may do
  // this; they were never the owner's to keep), after which the account can close.
  if (acct.withheld > 0n) ixs.push(createHarvestWithheldTokensToMintInstruction(mint, [acct.address], TOKEN_2022_PROGRAM_ID));
  if (action === "burn+close") ixs.push(createBurnCheckedInstruction(acct.address, mint, owner, acct.rawAmount, acct.decimals, [], acct.tokenProgram));
  // closing a wrapped-SOL account unwraps it: its whole balance lands in the wallet with the rent
  ixs.push(createCloseAccountInstruction(acct.address, owner, owner, [], acct.tokenProgram));
  return ixs;
}

function compile(owner: PublicKey, items: ReclaimItem[], cuLimit: number, cuPrice: number, blockhash: string): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ...items.flatMap((it) => instructionsFor(it, owner)),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/** Greedy: keep adding accounts to the current transaction while it still fits, then start the next one. */
export function packReclaim(owner: PublicKey, items: ReclaimItem[], cuPrice: number): { groups: ReclaimItem[][]; tooLarge: ReclaimItem[] } {
  const groups: ReclaimItem[][] = [];
  const tooLarge: ReclaimItem[] = [];
  const blank = PublicKey.default.toBase58();
  let cur: ReclaimItem[] = [];
  for (const it of items) {
    if (fits(compile(owner, [...cur, it], CU_MAX, cuPrice, blank))) cur.push(it);
    else if (cur.length && fits(compile(owner, [it], CU_MAX, cuPrice, blank))) {
      groups.push(cur);
      cur = [it];
    } else tooLarge.push(it);
  }
  if (cur.length) groups.push(cur);
  return { groups, tooLarge };
}

/** Recent priority fees for these accounts, clamped to the same bounds the swaps use. */
export async function priorityPrice(connection: Connection, accounts: PublicKey[]): Promise<number> {
  try {
    const fees = (await connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts.slice(0, 128) })).map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const p75 = fees.length ? fees[Math.floor(fees.length * 0.75)] : 0;
    return Math.min(Math.max(p75, MIN_CU_PRICE), MAX_CU_PRICE);
  } catch {
    return MIN_CU_PRICE;
  }
}

// SPL Token error codes (shared by Token-2022) a close or burn can hit, in words a person can act on.
const TOKEN_ERRORS: Record<number, string> = {
  1: "its balance changed since the list was read",
  4: "it isn't owned by this wallet",
  11: "it still holds tokens",
  17: "the account is frozen by the token's issuer",
};

/** A transaction-level failure (not tied to one instruction) applies to every account in it. */
function txLevelReason(err: unknown): string {
  const s = JSON.stringify(err) ?? "";
  if (/InsufficientFundsForFee|AccountNotFound/.test(s)) return "not enough SOL in the wallet for network fees";
  if (/InsufficientFundsForRent/.test(s)) return "the wallet's SOL balance would drop below rent";
  return `the network rejected it (${s.slice(0, 80)})`;
}

function instructionReason(err: unknown): string {
  const custom = JSON.stringify(err)?.match(/"Custom":(\d+)/);
  if (custom && TOKEN_ERRORS[+custom[1]]) return TOKEN_ERRORS[+custom[1]];
  return `the network rejected closing it (${(JSON.stringify(err) ?? "").slice(0, 80)})`;
}

/**
 * Packs, simulates and sizes reclaim transactions. Unsigned; the owner pays the network fee and receives the rent.
 * When a simulation fails on one instruction, that instruction's account is dropped and the rest re-simulated;
 * when the failing instruction can't be pinned to one account, the group is bisected until it can.
 */
export async function planReclaim(connection: Connection, owner: PublicKey, items: ReclaimItem[]): Promise<ReclaimPlan> {
  const cuPrice = await priorityPrice(connection, items.map((i) => i.acct.address));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const { groups, tooLarge } = packReclaim(owner, items, cuPrice);
  const skipped = tooLarge.map((it) => ({ address: it.acct.address.toBase58(), reason: "too large to fit in a transaction" }));
  const batches: ReclaimBatch[] = [];
  let sims = 0;

  const simulate = async (group: ReclaimItem[]) => {
    sims++;
    return (await connection.simulateTransaction(compile(owner, group, CU_MAX, cuPrice, blockhash), { sigVerify: false, replaceRecentBlockhash: true })).value;
  };
  const accept = (group: ReclaimItem[], units: number | undefined) => {
    const cuLimit = units ? Math.min(Math.ceil(units * 1.2), CU_MAX) : CU_MAX;
    batches.push({ items: group, tx: compile(owner, group, cuLimit, cuPrice, blockhash), cuLimit });
  };
  const skipAll = (group: ReclaimItem[], reason: string) => group.forEach((it) => skipped.push({ address: it.acct.address.toBase58(), reason }));
  // Which item produced instruction #idx (two compute-budget instructions come first).
  const ownerOf = (group: ReclaimItem[], idx: number): number => {
    let at = 2;
    for (let i = 0; i < group.length; i++) {
      at += instructionsFor(group[i], owner).length;
      if (idx < at) return i;
    }
    return -1;
  };

  const settle = async (start: ReclaimItem[]): Promise<void> => {
    let group = start;
    while (group.length) {
      if (sims >= MAX_SIMULATIONS) return skipAll(group, "couldn't be checked right now; try again");
      const sim = await simulate(group);
      if (!sim.err) return accept(group, sim.unitsConsumed);
      const ie = (sim.err as { InstructionError?: [number, unknown] }).InstructionError;
      if (!ie) return skipAll(group, txLevelReason(sim.err));
      const bad = ownerOf(group, ie[0]);
      if (bad >= 0) {
        skipped.push({ address: group[bad].acct.address.toBase58(), reason: instructionReason(ie[1]) });
        group = group.filter((_, i) => i !== bad);
        continue;
      }
      if (group.length === 1) return skipAll(group, instructionReason(ie[1]));
      const mid = Math.ceil(group.length / 2);
      await settle(group.slice(0, mid));
      group = group.slice(mid);
    }
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SIM_LANES, groups.length) }, async () => {
    while (next < groups.length) await settle(groups[next++]);
  }));
  // keep the order the accounts were asked for, so the review reads the same as the list
  const order = new Map(items.map((it, i) => [it.acct.address.toBase58(), i]));
  batches.sort((a, b) => order.get(a.items[0].acct.address.toBase58())! - order.get(b.items[0].acct.address.toBase58())!);
  return { batches, skipped, blockhash, lastValidBlockHeight, cuPrice };
}
