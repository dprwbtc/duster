// On-chain token metadata (name, symbol, uri), read with plain RPC so it costs no Jupiter quota.
// Two places hold it: the Token-2022 TokenMetadata extension inside the mint account itself, or a Metaplex
// metadata account at a PDA of the mint (classic SPL tokens, and Token-2022 mints without the extension).
// Everything read here is chosen by whoever minted the token, so it's treated as untrusted text.
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getExtensionData, unpackMint } from "@solana/spl-token";

export const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const METAPLEX_METADATA_V1 = 4; // the account's leading "key" byte
const MAX_KEYS_PER_CALL = 100; // getMultipleAccountsInfo limit

export interface OnchainMeta {
  name: string;
  symbol: string;
  uri: string;
}

export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()], METAPLEX_PROGRAM_ID)[0];
}

/** Reads `count` borsh strings (u32 little-endian length, then UTF-8) starting at `off`. Null if any is malformed. */
function borshStrings(data: Buffer, off: number, count: number): string[] | null {
  return borshStringsAt(data, off, count)?.strings ?? null;
}
/** Same, and where the last string ends, so a parser can carry on reading the fields after it. */
function borshStringsAt(data: Buffer, off: number, count: number): { strings: string[]; end: number } | null {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 4 > data.length) return null;
    const len = data.readUInt32LE(off);
    off += 4;
    // Metaplex pads name/symbol/uri to 32/10/200 bytes; anything far beyond that is garbage, not metadata
    if (len > 1024 || off + len > data.length) return null;
    // padding NULs and control characters never belong in a label or a URL
    out.push(data.subarray(off, off + len).toString("utf8").replace(/[\u0000-\u001f\u007f]/g, "").trim());
    off += len;
  }
  return { strings: out, end: off };
}

const toMeta = (s: string[] | null): OnchainMeta | null =>
  s ? { name: s[0].slice(0, 64), symbol: s[1].slice(0, 32), uri: s[2].slice(0, 2048) } : null;

/** Metaplex Metadata: key u8, update_authority 32, mint 32, then name, symbol, uri. */
export function parseMetaplex(data: Buffer, mint: PublicKey): OnchainMeta | null {
  if (data.length < 65 || data[0] !== METAPLEX_METADATA_V1) return null;
  if (!data.subarray(33, 65).equals(mint.toBuffer())) return null;
  return toMeta(borshStrings(data, 65, 3));
}

/** Metaplex TokenStandard. Everything but Fungible (2) means "not an ordinary token". */
export const TokenStandard = { NonFungible: 0, FungibleAsset: 1, Fungible: 2, NonFungibleEdition: 3, ProgrammableNonFungible: 4, ProgrammableNonFungibleEdition: 5 } as const;

/** The Metaplex fields after `uri` that say what kind of asset a mint is. Null where the account doesn't have them. */
export interface MetaplexDetails {
  sellerFeeBps: number | null;
  creators: { address: string; verified: boolean; share: number }[] | null;
  primarySaleHappened: boolean | null;
  isMutable: boolean | null;
  editionNonce: number | null;
  tokenStandard: number | null;
  collection: { verified: boolean; key: string } | null;
  /** True once token_standard was reached (read as a value or None). Older accounts end, or turn to padding, before. */
  complete: boolean;
}

/**
 * The whole Metaplex Metadata account as far as it goes: name, symbol, uri, then seller_fee_basis_points u16,
 * creators Option<Vec<{address 32, verified u8, share u8}>>, primary_sale_happened u8, is_mutable u8,
 * edition_nonce Option<u8>, token_standard Option<u8>, collection Option<{verified u8, key 32}>. Accounts written by
 * older program versions stop early (or are zero-padded, which reads as None), so every field past `uri` is optional,
 * and anything that doesn't parse ends the read there instead of guessing. Null only if the header or strings are bad.
 */
export function parseMetaplexFull(data: Buffer, mint: PublicKey): { meta: OnchainMeta; details: MetaplexDetails } | null {
  if (data.length < 65 || data[0] !== METAPLEX_METADATA_V1) return null;
  if (!data.subarray(33, 65).equals(mint.toBuffer())) return null;
  const s = borshStringsAt(data, 65, 3);
  if (!s) return null;
  const d: MetaplexDetails = { sellerFeeBps: null, creators: null, primarySaleHappened: null, isMutable: null, editionNonce: null, tokenStandard: null, collection: null, complete: false };
  let off = s.end;
  const left = (n: number) => off + n <= data.length;
  // an Option tag is 0 (None) or 1 (Some); anything else means we've walked off the real data
  const option = (): boolean | null => (left(1) && data[off] <= 1 ? data[off++] === 1 : null);
  read: {
    if (!left(2)) break read;
    d.sellerFeeBps = data.readUInt16LE(off);
    off += 2;
    const hasCreators = option();
    if (hasCreators === null) break read;
    if (hasCreators) {
      if (!left(4)) break read;
      const n = data.readUInt32LE(off);
      off += 4;
      if (n > 10 || !left(n * 34)) break read; // Metaplex allows 5 creators
      d.creators = [];
      for (let i = 0; i < n; i++, off += 34)
        d.creators.push({ address: new PublicKey(data.subarray(off, off + 32)).toBase58(), verified: data[off + 32] === 1, share: data[off + 33] });
    }
    if (!left(2)) break read;
    d.primarySaleHappened = data[off++] === 1;
    d.isMutable = data[off++] === 1;
    const hasNonce = option();
    if (hasNonce === null) break read;
    if (hasNonce) {
      if (!left(1)) break read;
      d.editionNonce = data[off++];
    }
    const hasStandard = option();
    if (hasStandard === null) break read;
    if (hasStandard) {
      if (!left(1) || data[off] > 5) break read; // an unknown standard is left unknown, never guessed
      d.tokenStandard = data[off++];
    }
    d.complete = true;
    const hasCollection = option();
    if (hasCollection && left(33)) d.collection = { verified: data[off] === 1, key: new PublicKey(data.subarray(off + 1, off + 33)).toBase58() };
  }
  return { meta: toMeta(s.strings)!, details: d };
}

/** Token-2022 TokenMetadata extension: update_authority 32, mint 32, then name, symbol, uri (same encoding). */
export function parseToken2022Meta(mint: PublicKey, info: AccountInfo<Buffer>): OnchainMeta | null {
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  try {
    const ext = getExtensionData(ExtensionType.TokenMetadata, unpackMint(mint, info, TOKEN_2022_PROGRAM_ID).tlvData);
    if (!ext || ext.length < 64 || !ext.subarray(32, 64).equals(mint.toBuffer())) return null;
    return toMeta(borshStrings(ext, 64, 3));
  } catch {
    return null;
  }
}

export const isTokenProgram = (owner: PublicKey) => owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);

// Names and URIs barely ever change, so a warm instance keeps them for an hour (misses for ten minutes), and a
// list of 300 empty accounts doesn't re-read 300 PDAs on every visit.
const META_TTL_MS = 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;
const memo = new Map<string, { at: number; meta: OnchainMeta | null; isMint: boolean }>();
/** Lets another reader that already fetched a mint's metadata (the NFT classifier) save readMeta the RPC call. */
export function rememberMeta(mint: string, meta: OnchainMeta | null, isMint: boolean) {
  remember(mint, meta, isMint);
}
function remember(mint: string, meta: OnchainMeta | null, isMint: boolean) {
  if (memo.size > 5_000) for (const k of [...memo.keys()].slice(0, 1_000)) memo.delete(k);
  memo.set(mint, { at: Date.now(), meta, isMint });
}

/**
 * On-chain metadata for many mints. `program` says which token program owns a mint when the caller already
 * knows (from a token account), so classic-SPL mints skip reading the mint account and cost one key, not two.
 * The result also says whether each address is a token mint at all, so the image proxy can reject garbage early.
 * RPC errors propagate; a missing or unparsable account is just null.
 */
export async function readMeta(
  connection: Connection,
  mints: string[],
  program?: Map<string, "token" | "token-2022">,
): Promise<Map<string, { meta: OnchainMeta | null; isMint: boolean }>> {
  const out = new Map<string, { meta: OnchainMeta | null; isMint: boolean }>();
  const todo: { mint: PublicKey; key: string; readMint: boolean }[] = [];
  const now = Date.now();
  for (const key of new Set(mints)) {
    const hit = memo.get(key);
    if (hit && now - hit.at < (hit.meta ? META_TTL_MS : MISS_TTL_MS)) out.set(key, { meta: hit.meta, isMint: hit.isMint });
    else todo.push({ mint: new PublicKey(key), key, readMint: program?.get(key) !== "token" });
  }
  const keys: { k: PublicKey; i: number; kind: "mint" | "pda" }[] = [];
  todo.forEach((t, i) => {
    if (t.readMint) keys.push({ k: t.mint, i, kind: "mint" });
    keys.push({ k: metadataPda(t.mint), i, kind: "pda" });
  });
  const mintInfo: (AccountInfo<Buffer> | null)[] = [];
  const pdaInfo: (AccountInfo<Buffer> | null)[] = [];
  const chunks: (typeof keys)[] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) chunks.push(keys.slice(i, i + MAX_KEYS_PER_CALL));
  await Promise.all(
    chunks.map(async (chunk) => {
      const infos = await connection.getMultipleAccountsInfo(chunk.map((c) => c.k));
      chunk.forEach((c, j) => ((c.kind === "mint" ? mintInfo : pdaInfo)[c.i] = infos[j] ?? null));
    }),
  );
  todo.forEach((t, i) => {
    const mi = mintInfo[i] ?? null;
    // a mint we didn't read is known to be one (the caller saw a token account for it)
    const isMint = t.readMint ? !!mi && isTokenProgram(mi.owner) : true;
    let meta: OnchainMeta | null = null;
    if (isMint) {
      if (mi) meta = parseToken2022Meta(t.mint, mi);
      const pda = pdaInfo[i];
      if (!meta && pda && pda.owner.equals(METAPLEX_PROGRAM_ID)) meta = parseMetaplex(pda.data, t.mint);
    }
    remember(t.key, meta, isMint);
    out.set(t.key, { meta, isMint });
  });
  return out;
}

// The image proxy is asked for one mint per request, often dozens at once as a list scrolls into view. Mints
// asked for within a few milliseconds of each other share one getMultipleAccountsInfo call.
let queue: { mint: string; resolve: (v: { meta: OnchainMeta | null; isMint: boolean }) => void; reject: (e: unknown) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
export function readMetaBatched(connection: Connection, mint: string): Promise<{ meta: OnchainMeta | null; isMint: boolean }> {
  return new Promise((resolve, reject) => {
    queue.push({ mint, resolve, reject });
    const flush = () => {
      timer = null;
      const batch = queue;
      queue = [];
      readMeta(connection, batch.map((q) => q.mint)).then(
        (m) => batch.forEach((q) => q.resolve(m.get(q.mint) ?? { meta: null, isMint: false })),
        (e) => batch.forEach((q) => q.reject(e)),
      );
    };
    if (queue.length >= 50) {
      if (timer) clearTimeout(timer);
      flush();
    } else if (!timer) timer = setTimeout(flush, 15);
  });
}
