// Which mints are NFTs (or SFTs, editions, programmable NFTs, collectibles): Duster never sells, burns or lists those
// as tokens. Decided from the chain alone (plain RPC, no Jupiter quota), from three accounts per mint:
//   - the mint itself: decimals, supply, owning program and, for Token-2022, its extensions;
//   - the Metaplex metadata PDA: token_standard (and collection) past the name/symbol/uri meta.ts already reads;
//   - the Metaplex edition PDA ["metadata", MPL, mint, "edition"]: a master edition or a print. Only decimals-0
//     mints can have one, so only those pay for the read.
// A mint with decimals is always fungible: Metaplex only lets decimals-0 mints be NFTs, editions or pNFTs, and the one
// standard a mint with decimals can carry (FungibleAsset, set by CreateV1) doesn't make it an SFT. A decimals-0 mint is
// non-fungible if ANY marker says so. A decimals-0 mint with no marker either way (an old SFT such as a Star Atlas
// ship, a game resource, a 0-decimal memecoin: the chain can't tell them apart) is a "collectible" whose answer is
// left to the price (`tokenIfPriced`): the caller treats it as a token only if Jupiter prices it, and leaves it alone
// otherwise. When a decimals-0 mint can't be read for certain, it's treated as an NFT (fail closed, `unsure`):
// wrongly hiding a 0-decimal coin costs nothing, wrongly burning an NFT can't be undone.
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, getExtensionTypes, unpackMint } from "@solana/spl-token";
import { METAPLEX_PROGRAM_ID, TokenStandard, isTokenProgram, metadataPda, parseMetaplexFull, parseToken2022Meta, rememberMeta, type OnchainMeta } from "./meta.js";

export type NftKind = "nft" | "pnft" | "edition" | "sft" | "t22-nft" | "collectible";
export interface MintClass {
  nft: boolean;
  kind: NftKind | null;
  /** Short reason, for logs and the verification script; never shown to users. */
  why: string;
  decimals: number | null;
  /** On-chain name/symbol/uri when the read found any (Token-2022 extension first, then Metaplex). */
  meta: OnchainMeta | null;
  /** Set when an RPC read failed and the answer is the fail-safe one, not a reading of the chain. Never cached. */
  unsure?: true;
  /**
   * Set on a decimals-0 "collectible" with no NFT marker (nft: true, kind "collectible"): it's a token if, and only
   * if, Jupiter has a price for it. Callers that have the price decide; callers that don't leave it alone.
   */
  tokenIfPriced?: true;
}
/** Non-fungible kinds a person would call an NFT; the rest ("sft", "collectible") are game items, editions of a run… */
export const isNftKind = (k: string | null | undefined) => k === "nft" || k === "pnft" || k === "edition" || k === "t22-nft";
/** What the caller already knows about a mint from a token account: its decimals. Used when the mint can't be read. */
export type MintHints = Map<string, { decimals?: number }>;

const MAX_KEYS_PER_CALL = 100; // getMultipleAccountsInfo limit
const LANES = 3; // parallel RPC calls: a 1,500-account wallet is ~30-45 calls, and RPCs throttle bursts
const RETRY_MS = [1_500]; // one more try after a failed call (web3.js already retried a 429 a few times by then)
const TTL_MS = 10 * 60_000;
const memo = new Map<string, { at: number; c: MintClass }>();

// Metaplex account "key" bytes for editions
const EDITION_V1 = 1; // a numbered print of a master edition
const MASTER_EDITION_V1 = 2;
const MASTER_EDITION_V2 = 6;

export function editionPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from("edition")], METAPLEX_PROGRAM_ID)[0];
}

/** Reads accounts 100 per call, a few calls at a time. A failed call leaves its slots `undefined` ("unknown"), not null ("no account"). */
async function readAccounts(connection: Connection, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null | undefined)[]> {
  const out: (AccountInfo<Buffer> | null | undefined)[] = new Array(keys.length).fill(undefined);
  const starts: number[] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) starts.push(i);
  let next = 0, failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, starts.length) }, async () => {
      while (next < starts.length) {
        const i = starts[next++];
        for (let attempt = 0; ; attempt++) {
          try {
            const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + MAX_KEYS_PER_CALL));
            infos.forEach((info, j) => (out[i + j] = info ?? null));
            break;
          } catch (e) {
            if (attempt < RETRY_MS.length) { await new Promise((r) => setTimeout(r, RETRY_MS[attempt])); continue; }
            if (!failed++) console.error("nft classifier: account read failed", String(e).slice(0, 200));
            break;
          }
        }
      }
    }),
  );
  return out;
}

const T22_GROUP_EXTENSIONS = new Set([ExtensionType.TokenGroupMember, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroup, ExtensionType.GroupPointer]);
// token_standard values that make a decimals-0 mint an NFT outright. FungibleAsset isn't one: Metaplex sets it on every
// decimals-0 mint whose metadata was created after token_standard existed, memecoins included (see decide()).
const STANDARD_KIND: Record<number, NftKind | undefined> = {
  [TokenStandard.NonFungible]: "nft",
  [TokenStandard.NonFungibleEdition]: "edition",
  [TokenStandard.ProgrammableNonFungible]: "pnft",
  [TokenStandard.ProgrammableNonFungibleEdition]: "pnft",
};

interface Todo {
  key: string;
  mint: PublicKey;
  hintDecimals: number | undefined;
  mintInfo?: AccountInfo<Buffer> | null;
  pdaInfo?: AccountInfo<Buffer> | null;
  edInfo?: AccountInfo<Buffer> | null;
  edRead: boolean;
}

const fungible = (why: string, decimals: number | null, meta: OnchainMeta | null): MintClass => ({ nft: false, kind: null, why, decimals, meta });
const nonFungible = (kind: NftKind, why: string, decimals: number | null, meta: OnchainMeta | null): MintClass => ({ nft: true, kind, why, decimals, meta });
const collectible = (why: string, meta: OnchainMeta | null): MintClass => ({ nft: true, kind: "collectible", why, decimals: 0, meta, tokenIfPriced: true });
/** A FungibleAsset with fewer than this many units is a run of items (an SFT), whatever Jupiter says about it. */
const SFT_MAX_SUPPLY = 1_000_000n;

/** Classifies one mint from what was read. `final` is false when something was unreadable, so the answer isn't cached. */
function decide(t: Todo): { c: MintClass; final: boolean } {
  const mi = t.mintInfo;
  // Mint unreadable (RPC failed), gone (a closed Token-2022 mint) or not a mint at all: decimals from the token
  // account decide. A decimals-0 (or unknown) mint is an NFT until proven otherwise.
  if (!mi || !isTokenProgram(mi.owner)) {
    const final = mi !== undefined;
    const d = t.hintDecimals ?? null;
    if (d === null || d === 0) return { c: nonFungible("nft", mi === undefined ? "mint unreadable, decimals 0: fail closed" : "no mint account, decimals 0: fail closed", d, null), final };
    return { c: fungible(mi === undefined ? "mint unreadable, has decimals" : "no mint account, has decimals", d, null), final };
  }
  let mint;
  try {
    mint = unpackMint(t.mint, mi, mi.owner);
  } catch {
    const d = t.hintDecimals ?? null;
    return { c: d === null || d === 0 ? nonFungible("nft", "mint unparsable, decimals 0: fail closed", d, null) : fungible("mint unparsable, has decimals", d, null), final: true };
  }
  const decimals = mint.decimals;
  const t22 = mi.owner.equals(TOKEN_2022_PROGRAM_ID);
  let meta = t22 ? parseToken2022Meta(t.mint, mi) : null;
  // metadata PDA: unknown if the read failed, absent if null or not a Metaplex account
  const pda = t.pdaInfo;
  const full = pda && pda.owner.equals(METAPLEX_PROGRAM_ID) ? parseMetaplexFull(pda.data, t.mint) : null;
  if (!meta && full) meta = full.meta;
  const std = full?.details.tokenStandard ?? null;
  // A mint with decimals is fungible, whatever its metadata says: NFTs, editions and pNFTs need decimals 0, and a
  // FungibleAsset with decimals (XFEE, ZYNX: created with CreateV1) is an ordinary token. Nothing else needs reading.
  if (decimals > 0) return { c: fungible(std === null ? "has decimals" : `has decimals, token_standard ${std}`, decimals, meta), final: true };

  // decimals 0 from here on
  const stdKind = std === null ? undefined : STANDARD_KIND[std];
  if (stdKind) return { c: nonFungible(stdKind, `token_standard ${std}`, decimals, meta), final: true };
  if (t22) {
    let exts: ExtensionType[] = [];
    try {
      exts = getExtensionTypes(mint.tlvData);
    } catch {}
    if (exts.some((e) => T22_GROUP_EXTENSIONS.has(e))) return { c: nonFungible("t22-nft", "Token-2022 group/member extension", decimals, meta), final: true };
  }
  if (mint.supply <= 1n) return { c: nonFungible(t22 ? "t22-nft" : "nft", `decimals 0, supply ${mint.supply}`, decimals, meta), final: true };
  // Editions: a print is an edition; a master edition is the original NFT (or the master of an open edition).
  const ed = t.edInfo;
  if (ed && ed.owner.equals(METAPLEX_PROGRAM_ID) && ed.data.length > 0) {
    if (ed.data[0] === EDITION_V1) return { c: nonFungible("edition", "edition account (print)", decimals, meta), final: true };
    if (ed.data[0] === MASTER_EDITION_V1 || ed.data[0] === MASTER_EDITION_V2) return { c: nonFungible("nft", "master edition account", decimals, meta), final: true };
  }
  // A collection only belongs on NFT-like assets; an SFT minted before token_standard existed can carry one.
  if (full?.details.collection) return { c: nonFungible("sft", "decimals 0 with a collection", decimals, meta), final: true };
  // Couldn't see everything that could have said "NFT": fail closed, and don't remember the answer.
  if (pda === undefined || !t.edRead || ed === undefined) return { c: nonFungible("nft", "decimals 0, metadata or edition unreadable: fail closed", decimals, meta), final: false };
  if (pda && pda.owner.equals(METAPLEX_PROGRAM_ID) && !full) return { c: nonFungible("nft", "decimals 0, metadata unparsable: fail closed", decimals, meta), final: true };
  // No marker either way. FungibleAsset is what Metaplex writes on every decimals-0 mint, so on its own it says
  // nothing; a small run (Star Atlas crafting parts, a few thousand items) is an SFT, and a big supply (FOXY: 68
  // billion) is a coin if Jupiter prices it. With no standard at all (metadata from before token_standard: Star Atlas
  // ships, old spam "NFT" airdrops, and 0-decimal coins like XCOPE alike) the price decides too.
  if (std === TokenStandard.FungibleAsset && mint.supply < SFT_MAX_SUPPLY) return { c: nonFungible("sft", `token_standard 1, decimals 0, supply ${mint.supply}`, decimals, meta), final: true };
  return { c: collectible(`decimals 0, supply ${mint.supply}, token_standard ${std ?? "none"}, no NFT markers: a token only if priced`, meta), final: true };
}

/**
 * Classifies many mints. Never throws: an RPC failure turns into "NFT" for decimals-0 mints and "fungible" for the
 * rest (by the hint's decimals), and only answers from complete reads are remembered (ten minutes per warm instance).
 */
export async function classifyMints(connection: Connection, mints: string[], hints?: MintHints): Promise<Map<string, MintClass>> {
  const out = new Map<string, MintClass>();
  const now = Date.now();
  const todo: Todo[] = [];
  for (const key of new Set(mints)) {
    const hit = memo.get(key);
    if (hit && now - hit.at < TTL_MS) { out.set(key, hit.c); continue; }
    let mint: PublicKey;
    try {
      mint = new PublicKey(key);
    } catch {
      continue;
    }
    todo.push({ key, mint, hintDecimals: hints?.get(key)?.decimals, edRead: false });
  }
  if (!todo.length) return out;

  // Round 1: mint + metadata for every mint, plus the edition when the token account already says decimals 0.
  const keys: PublicKey[] = [];
  const slots: { t: Todo; field: "mintInfo" | "pdaInfo" | "edInfo" }[] = [];
  for (const t of todo) {
    keys.push(t.mint), slots.push({ t, field: "mintInfo" });
    keys.push(metadataPda(t.mint)), slots.push({ t, field: "pdaInfo" });
    if (t.hintDecimals === 0) (keys.push(editionPda(t.mint)), slots.push({ t, field: "edInfo" }), (t.edRead = true));
  }
  (await readAccounts(connection, keys)).forEach((info, i) => (slots[i].t[slots[i].field] = info));

  // Round 2: editions of decimals-0 mints that round 1 didn't cover (no hint, or the hint was wrong).
  const late = todo.filter((t) => {
    if (t.edRead || !t.mintInfo || !isTokenProgram(t.mintInfo.owner)) return false;
    try {
      return unpackMint(t.mint, t.mintInfo, t.mintInfo.owner).decimals === 0;
    } catch {
      return false;
    }
  });
  if (late.length) {
    const infos = await readAccounts(connection, late.map((t) => editionPda(t.mint)));
    late.forEach((t, i) => ((t.edInfo = infos[i]), (t.edRead = true)));
  }

  if (memo.size > 20_000) for (const k of [...memo.keys()].slice(0, 5_000)) memo.delete(k);
  for (const t of todo) {
    const { c, final } = decide(t);
    if (!final) c.unsure = true;
    out.set(t.key, c);
    if (final) memo.set(t.key, { at: now, c });
    // the names came along for free: the cleanup list and the image proxy needn't read the same PDA again
    if (t.mintInfo !== undefined && t.pdaInfo !== undefined) rememberMeta(t.key, c.meta, !!t.mintInfo && isTokenProgram(t.mintInfo.owner));
  }
  return out;
}

/** Token-account decimals as classifier hints. */
export function hintsFrom(list: { mint: string; decimals: number }[]): MintHints {
  return new Map(list.map((x) => [x.mint, { decimals: x.decimals }]));
}

/** Counts by kind, for logs. */
export function kindCounts(classes: Iterable<MintClass>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of classes) out[c.kind ?? "fungible"] = (out[c.kind ?? "fungible"] ?? 0) + 1;
  return out;
}
