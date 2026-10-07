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
  return out;
}

const toMeta = (s: string[] | null): OnchainMeta | null =>
  s ? { name: s[0].slice(0, 64), symbol: s[1].slice(0, 32), uri: s[2].slice(0, 2048) } : null;

/** Metaplex Metadata: key u8, update_authority 32, mint 32, then name, symbol, uri. */
export function parseMetaplex(data: Buffer, mint: PublicKey): OnchainMeta | null {
  if (data.length < 65 || data[0] !== METAPLEX_METADATA_V1) return null;
  if (!data.subarray(33, 65).equals(mint.toBuffer())) return null;
  return toMeta(borshStrings(data, 65, 3));
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
