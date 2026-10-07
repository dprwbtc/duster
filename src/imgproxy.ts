// Token images through our own origin. A token's image URL is chosen by whoever minted it (often a per-wallet
// airdrop), so loading it straight from the visitor's browser would hand that person the visitor's IP at the
// moment they open Duster. Instead the server fetches it, checks it really is a raster image, re-encodes it as a
// small WebP, and serves it from /api/img. That also makes this an attacker-steered HTTP client on our server,
// so every hop is SSRF-guarded: https only, no IP literals or internal names, and the address we actually
// connect to is checked at connect time (no DNS-rebinding window), with redirects, time and size all capped.
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import type { Connection } from "@solana/web3.js";
import sharp from "sharp";
import { readMetaBatched } from "./meta.js";

const JSON_MAX = 256 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const JSON_TIMEOUT_MS = 4_000;
const IMAGE_TIMEOUT_MS = 6_000;
const TOTAL_BUDGET_MS = 11_000; // under the function's 15s maxDuration, with room for the RPC read and sharp
const SIZE = 128;

sharp.cache(false); // serverless memory is small; every output is cached below anyway
sharp.concurrency(1);

/* ---------------- address and URL guard ---------------- */

const v4Blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) v4Blocked.addSubnet(a, p, "ipv4");

/** 16 bytes of an IPv6 address (handles "::" and a trailing dotted IPv4), or null. */
function v6Bytes(addr: string): number[] | null {
  let s = addr.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!net.isIPv6(s)) return null;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, rest] = s.split("::");
  const hp = head ? head.split(":") : [];
  const rp = rest !== undefined && rest ? rest.split(":") : [];
  const groups = rest === undefined ? hp : [...hp, ...Array(8 - hp.length - rp.length).fill("0"), ...rp];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
}

/**
 * Only globally routable unicast addresses. IPv4: everything private, loopback, link-local, CGNAT, multicast,
 * reserved, documentation or unspecified is refused. IPv6: only 2000::/3 (global unicast) minus documentation,
 * Teredo/ORCHID (2001::/23) and 6to4 (2002::/16, which can wrap a private IPv4); IPv4-mapped addresses are
 * judged by the IPv4 inside.
 */
export function isPublicAddress(addr: string, family?: number): boolean {
  if ((family === 4 || family === undefined) && net.isIPv4(addr)) return !v4Blocked.check(addr, "ipv4");
  const b = v6Bytes(addr);
  if (!b) return false;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return isPublicAddress(b.slice(12).join("."), 4);
  if ((b[0] & 0xe0) !== 0x20) return false; // ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96, ...
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] < 0x02) return false; // 2001::/23
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 6to4
  if (b[0] === 0x3f && b[1] === 0xff && b[2] < 0x10) return false; // 3fff::/20 documentation
  return true;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".private", ".test", ".invalid", ".example", ".onion"];

/** Why a URL may not be fetched, or null when it may (the connect-time address check still applies). */
export function urlProblem(u: URL): string | null {
  if (u.protocol !== "https:") return "not https";
  if (u.username || u.password) return "credentials in URL";
  if (u.port && u.port !== "443") return "non-default port";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // the WHATWG parser already turned 2130706433, 0x7f.1 and friends into dotted IPv4, so this catches them all
  if (host.startsWith("[") || net.isIP(host)) return "IP literal";
  if (!host.includes(".") || host === "localhost") return "internal hostname";
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "internal hostname";
  return null;
}

/** Turns a metadata URI into a fetchable https URL: ipfs:// and ar:// go through public gateways, http is upgraded. */
export function normalizeUri(raw: string, base?: URL): URL | null {
  let s = raw.trim();
  if (!s || s.length > 2048) return null;
  if (/^ipfs:\/\//i.test(s)) s = "https://ipfs.io/ipfs/" + s.replace(/^ipfs:\/\/(ipfs\/)?/i, "");
  else if (/^ar:\/\//i.test(s)) s = "https://arweave.net/" + s.slice(5);
  else if (/^http:\/\//i.test(s)) s = "https://" + s.slice(7);
  let u: URL;
  try {
    u = base ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:"; // a relative redirect from an upgraded URL
  return urlProblem(u) ? null : u;
}

// Runs inside the TLS connect, on the very addresses the socket will use, so a hostname can't pass a check and
// then resolve somewhere private for the real connection.
type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address, a.family)))
      return cb(Object.assign(new Error(`blocked address for ${hostname}`), { code: "EBLOCKED" }));
    if (options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

/** Resolves a hostname the same way the guarded connect does; for tests and diagnostics. */
export async function hostResolvesPublic(hostname: string): Promise<boolean> {
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address, a.family));
  } catch {
    return false;
  }
}

/* ---------------- guarded fetch ---------------- */

interface Got { body: Buffer; type: string; url: URL }

/** A failed fetch; `transient` ones (rate limits, 5xx, timeouts) are worth trying again later. */
export class FetchFail extends Error {
  constructor(msg: string, public transient = false) {
    super(msg);
  }
}

/**
 * The size cap for a body, decided from its declared type and its first bytes (`head`, at least 16 of them, or the
 * whole body if it's shorter). Lets the metadata hop give a real image 8 MB without giving an unlabeled blob the same.
 */
type MaxFor = (type: string, head: Buffer | null) => number;

// Every outbound fetch takes one of these, whatever its host: with wildcard subdomains the per-host queue is no
// limit at all, and each fetch may buffer up to IMAGE_MAX, so this is what bounds one instance's memory.
const MAX_FETCHES = 16;
let fetching = 0;
const fetchWaiters: (() => void)[] = [];
async function withFetchSlot<T>(deadline: number, fn: () => Promise<T>): Promise<T> {
  if (fetching >= MAX_FETCHES) {
    const wait = deadline - Date.now();
    if (wait <= 0) throw new FetchFail("timeout", true);
    await new Promise<void>((resolve, reject) => {
      const go = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { const i = fetchWaiters.indexOf(go); if (i >= 0) fetchWaiters.splice(i, 1); reject(new FetchFail("timeout", true)); }, wait);
      fetchWaiters.push(go);
    });
  }
  fetching++;
  try {
    return await fn();
  } finally {
    fetching--;
    fetchWaiters.shift()?.();
  }
}

/**
 * One GET with no redirect following. Size is enforced while streaming, on the decompressed bytes. The promise
 * always settles: every way the response can end (complete, aborted mid-body, decoder error, timeout) goes
 * through done(), and the hard timer is cleared only there, so a connection that dies half way through a
 * compressed body can't leave a caller (and the host and fetch slots it holds) waiting forever.
 */
function getOnce(u: URL, maxFor: MaxFor, timeoutMs: number): Promise<Got | { redirect: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const done = (err: unknown, value?: Got | { redirect: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(value!);
    };
    const req = https.request(
      {
        method: "GET", host: u.hostname, servername: u.hostname, port: 443, path: u.pathname + u.search,
        lookup: guardedLookup as unknown as typeof dns.lookup, agent: false,
        headers: { "user-agent": "duster-img/1.0", accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,application/json;q=0.9,*/*;q=0.5", "accept-encoding": "gzip, deflate, br" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return done(null, { redirect: res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return done(new FetchFail(`HTTP ${status}`, status === 429 || status >= 500));
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const declared = Number(res.headers["content-length"]);
        // the type alone already caps it (a body can only be bigger than its sniffed cap, never smaller)
        if (Number.isFinite(declared) && !enc && declared > Math.max(maxFor(type, null), 0)) return done(new Error("too large"));
        const decoder = enc === "gzip" ? zlib.createGunzip() : enc === "deflate" ? zlib.createInflate() : enc === "br" ? zlib.createBrotliDecompress() : null;
        if (enc && enc !== "identity" && !decoder) return done(new Error(`unsupported encoding ${enc.slice(0, 20)}`));
        const chunks: Buffer[] = [];
        let n = 0;
        let max = Infinity;
        let head: Buffer | null = null;
        const onData = (c: Buffer) => {
          if (settled) return;
          chunks.push(c);
          n += c.length;
          if (!head && n >= 16) max = maxFor(type, (head = Buffer.concat(chunks)));
          if (n > Math.min(max, IMAGE_MAX)) done(new Error("too large"));
        };
        const onEnd = () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          if (!head && body.length > maxFor(type, body)) return done(new Error("too large"));
          done(null, { body, type, url: u });
        };
        // a body that stops before it's complete is a transient failure (the host dropped us), never a hang
        res.on("aborted", () => done(new FetchFail("aborted", true)));
        res.on("error", (e) => done(new FetchFail(e.message || "aborted", true)));
        res.on("close", () => { if (!res.complete) done(new FetchFail("aborted", true)); });
        if (decoder) {
          // pipeline() passes errors both ways, so a cut-off response destroys the decoder too
          pipeline(res, decoder, (e) => { if (e) done(e instanceof FetchFail ? e : new FetchFail(e.message || "aborted", true)); });
          decoder.on("data", onData);
          decoder.on("end", onEnd);
        } else {
          res.on("data", onData);
          res.on("end", onEnd);
        }
      },
    );
    req.setTimeout(timeoutMs, () => done(new FetchFail("timeout", true)));
    hard = setTimeout(() => done(new FetchFail("timeout", true)), timeoutMs);
    // network-level trouble (reset, DNS hiccup) may pass; a refused address or bad TLS won't
    req.on("error", (e: NodeJS.ErrnoException) => done(e instanceof FetchFail ? e : new FetchFail(e.message, ["ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"].includes(e.code ?? ""))));
    req.end();
  });
}

/**
 * GET with at most MAX_REDIRECTS redirects, each hop normalized and re-checked like the first. Every hop gets
 * min(timeoutMs, what's left before `deadline`), so a chain of slow redirects can't outlast the overall budget.
 */
export async function safeGet(start: URL, max: number | MaxFor, timeoutMs: number, deadline = Date.now() + timeoutMs): Promise<Got> {
  const maxFor: MaxFor = typeof max === "number" ? () => max : max;
  let u = start;
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(u);
    if (problem) throw new Error(problem);
    const left = Math.min(timeoutMs, deadline - Date.now());
    if (left <= 0) throw Object.assign(new FetchFail("timeout", true), { host: u.hostname });
    const hopUrl = u;
    const r = await withFetchSlot(deadline, () => getOnce(hopUrl, maxFor, Math.min(timeoutMs, Math.max(1, deadline - Date.now())))).catch((e) => {
      if (e && typeof e === "object") (e as { host?: string }).host = hopUrl.hostname; // for the one-line failure log
      throw e;
    });
    if (!("redirect" in r)) return r;
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    const next = normalizeUri(r.redirect, u);
    if (!next) throw new Error("bad redirect");
    u = next;
  }
}

// Most memecoin metadata lives on IPFS. The best-known public gateways (ipfs.io, dweb.link) now refuse
// non-browser clients, so content on any well-known public gateway is fetched from gateways that still serve
// servers, in order (IPFS_GATEWAYS overrides the list as gateways come and go). A content address is the same
// file everywhere, so this changes nothing about what's shown. A project's own gateway is tried first.
// (w3s.link and nftstorage.link only redirect to dweb.link and ipfs.io, which refuse servers, so they add nothing.)
const DEFAULT_GATEWAYS = "4everland.io,gateway.pinata.cloud";
const IPFS_GATEWAYS = (process.env.IPFS_GATEWAYS || DEFAULT_GATEWAYS)
  .split(",").map((g) => g.trim().toLowerCase()).filter((g) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(g));
const PUBLIC_GATEWAYS = new Set(["ipfs.io", "gateway.ipfs.io", "dweb.link", "w3s.link", "nftstorage.link", "cloudflare-ipfs.com", "cf-ipfs.com", "gateway.pinata.cloud", "4everland.io", ...IPFS_GATEWAYS]);
/** A gateway URL for `path`, or null unless it came out with exactly the host intended (no userinfo, no port). */
function gatewayUrl(host: string, path: string, search: string): URL | null {
  try {
    const g = new URL(`https://${host}${path}${search}`);
    return g.hostname === host && !g.username && !g.password && !g.port ? g : null;
  } catch {
    return null;
  }
}
export function ipfsCandidates(u: URL): URL[] {
  const host = u.hostname.toLowerCase();
  const sub = host.match(/^([a-z0-9]{46,})\.ipfs\.([a-z0-9.-]+)$/); // <cid>.ipfs.<gateway>
  // the CID must end the path segment: "/ipfs/<cid>.evil.example/x" is not IPFS content
  const m = sub ? null : u.pathname.match(/^\/ipfs\/([a-zA-Z0-9]{46,})(\/.*)?$/);
  const cid = sub ? sub[1] : m?.[1];
  if (!cid) return [u];
  const rest = sub ? (u.pathname === "/" ? "" : u.pathname) : m?.[2] ?? "";
  if (rest && !rest.startsWith("/")) return [u];
  const path = `/ipfs/${cid}${rest}`;
  // 4everland answers /ipfs/<cid> with a redirect to <cid>.ipfs.4everland.io; for a lowercase CIDv1 we can go
  // there directly and save a round trip (CIDv0 is case-sensitive, so it can't be a hostname)
  const all = IPFS_GATEWAYS.map((g) =>
    g === "4everland.io" && /^baf[a-z2-7]{50,}$/.test(cid) ? gatewayUrl(`${cid}.ipfs.4everland.io`, rest || "/", u.search) : gatewayUrl(g, path, u.search))
    .filter((g): g is URL => !!g);
  // a list scrolling into view asks for dozens of CIDs at once; starting each one at a different gateway (the
  // same one every time for a given CID) spreads that burst instead of queueing it all on the first gateway
  const start = all.length ? [...cid].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % all.length : 0;
  const gws = [...all.slice(start), ...all.slice(0, start)];
  return PUBLIC_GATEWAYS.has(sub ? sub[2] : host) ? gws.slice(0, 3) : [u, ...gws.filter((g) => g.hostname !== host)].slice(0, 3);
}
// A list scrolling into view asks for dozens of images at once, and most of them live on the same gateway.
// Gateways throttle bursts by stalling, so each host gets a few requests at a time and the rest queue.
const PER_HOST = 4;
const hostSlots = new Map<string, { n: number; waiting: (() => void)[] }>();
async function withHostSlot<T>(host: string, deadline: number, fn: () => Promise<T>): Promise<T> {
  let h = hostSlots.get(host);
  if (!h) hostSlots.set(host, (h = { n: 0, waiting: [] }));
  const slot = h;
  if (slot.n >= PER_HOST) {
    const wait = deadline - Date.now();
    if (wait <= 0) throw new FetchFail("timeout", true);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { slot.waiting.splice(slot.waiting.indexOf(go), 1); reject(new FetchFail("timeout", true)); }, wait);
      const go = () => { clearTimeout(t); resolve(); };
      slot.waiting.push(go);
    });
  }
  slot.n++;
  try {
    return await fn();
  } finally {
    slot.n--;
    slot.waiting.shift()?.();
    if (!slot.n && !slot.waiting.length) hostSlots.delete(host);
  }
}
async function getWithFallback(u: URL, max: number | MaxFor, timeoutMs: number, deadline: number): Promise<Got> {
  const tries = ipfsCandidates(u);
  let last: unknown;
  for (const [i, c] of tries.entries()) {
    if (i > 0 && deadline - Date.now() < 1_000) break;
    try {
      // the per-hop timeout starts once a slot is free; the overall deadline bounds the wait and every hop
      return await withHostSlot(c.hostname, deadline, () => safeGet(c, max, timeoutMs, deadline));
    } catch (e) {
      last = e;
      if (process.env.IMG_DEBUG) console.log(JSON.stringify({ imgTry: { host: c.hostname, err: String((e as Error)?.message ?? e).slice(0, 60) } }));
      // a gateway that rate-limits, errors or refuses (402/403/410...) may well be alone in that; a body that's
      // too large or an address that's refused would be the same everywhere
      if (!(e instanceof FetchFail) || /too large/.test(e.message)) throw e;
    }
  }
  throw last;
}

/* ---------------- image checks ---------------- */

/** Raster formats we accept, by magic bytes. SVG (scriptable) and everything else is refused. */
export function sniffImage(b: Buffer): "png" | "jpeg" | "gif" | "webp" | "avif" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (b.length >= 16 && b.subarray(4, 8).toString("latin1") === "ftyp") {
    const boxLen = Math.min(b.readUInt32BE(0), b.length, 64);
    const brands = b.subarray(8, boxLen).toString("latin1");
    if (/^avi[fs]/.test(brands) || (/^(mif1|msf1)/.test(brands) && /avi[fs]/.test(brands))) return "avif";
  }
  return null;
}

let sharpJobs = 0;
const sharpWaiters: (() => void)[] = [];
async function withSharpSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (sharpJobs >= 2) await new Promise<void>((r) => sharpWaiters.push(r));
  sharpJobs++;
  try {
    return await fn();
  } finally {
    sharpJobs--;
    sharpWaiters.shift()?.();
  }
}

/** Decodes the first frame (pixel-capped) and re-encodes a 128x128 WebP. Throws on anything sharp won't read. */
export function toThumb(b: Buffer): Promise<Buffer> {
  return withSharpSlot(async () => {
    const img = sharp(b, { limitInputPixels: 40_000_000, pages: 1, failOn: "error" });
    const meta = await img.metadata();
    const ok = ["png", "jpeg", "gif", "webp"].includes(meta.format ?? "") || (meta.format === "heif" && meta.compression === "av1");
    if (!ok) throw new Error(`unexpected format ${meta.format}`);
    return img.rotate().resize(SIZE, SIZE, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
  });
}

/* ---------------- metadata URI → thumbnail ---------------- */

function imageFromJson(body: Buffer): string | null {
  let j: any;
  try {
    j = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const f0 = Array.isArray(j.properties?.files) ? j.properties.files[0] : null;
  for (const c of [j.image, j.image_url, typeof f0 === "string" ? f0 : f0?.uri]) if (typeof c === "string" && c.trim()) return c;
  return null;
}

async function thumbFromUri(uri: string, deadline: number): Promise<Buffer | null> {
  const left = () => deadline - Date.now();
  const first = normalizeUri(uri);
  if (!first || left() < 500) return null;
  // the metadata URI is usually JSON, but some tokens point it straight at the image. JSON (or anything
  // text-like) is capped at 256 KB while streaming; 8 MB only for a body labelled as an image or whose first bytes
  // are one (IPFS gateways often say application/octet-stream for both)
  const metaMax: MaxFor = (type, head) =>
    /json|text|html|xml/.test(type) ? JSON_MAX : type.startsWith("image/") ? IMAGE_MAX : !head ? IMAGE_MAX : sniffImage(head) ? IMAGE_MAX : JSON_MAX;
  const meta = await getWithFallback(first, metaMax, JSON_TIMEOUT_MS, deadline);
  if (sniffImage(meta.body)) return toThumb(meta.body);
  if (meta.body.length > JSON_MAX) return null;
  const imageUri = imageFromJson(meta.body);
  const imageUrl = imageUri && normalizeUri(imageUri, meta.url);
  if (!imageUrl || left() < 500) return null;
  const pic = await getWithFallback(imageUrl, IMAGE_MAX, IMAGE_TIMEOUT_MS, deadline);
  return sniffImage(pic.body) ? toThumb(pic.body) : null;
}

/* ---------------- cache + entry point ---------------- */

// SOL and USDC carry on-chain metadata with an empty uri (their logos live in token lists), so they'd only ever
// get a letter. Their logos from the Solana token-list repository, fetched through the same guard. (USDT's logo
// there is an SVG, which is refused like any other, so it keeps its letter.)
const WELL_KNOWN: Record<string, string> = {
  So11111111111111111111111111111111111111112: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
};

const MISS_TTL_MS = 10 * 60_000;
const TRANSIENT_TTL_MS = 2 * 60_000;
type Result = { bytes: Buffer | null; transient: boolean };
const lru = new Map<string, { at: number } & Result>();
const inflight = new Map<string, Promise<Result>>();
function keep(mint: string, r: Result) {
  lru.delete(mint);
  lru.set(mint, { at: Date.now(), ...r });
  while (lru.size > 400) lru.delete(lru.keys().next().value!);
}

export class RpcUnavailable extends Error {}

/**
 * The thumbnail for a mint. `bytes` is null when there's no usable image; `transient` says whether that might
 * change soon (the image host rate-limited us or timed out) or not (no metadata, refused host, not a raster
 * image, ...). Throws RpcUnavailable when our own RPC failed, so that's never cached as "no image".
 */
export function tokenImage(connection: Connection, mint: string): Promise<Result> {
  const hit = lru.get(mint);
  if (hit && (hit.bytes || Date.now() - hit.at < (hit.transient ? TRANSIENT_TTL_MS : MISS_TTL_MS))) {
    keep(mint, hit);
    return Promise.resolve({ bytes: hit.bytes, transient: hit.transient });
  }
  const running = inflight.get(mint);
  if (running) return running;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const job = (async () => {
    let meta;
    try {
      meta = await readMetaBatched(connection, mint);
    } catch (e) {
      console.error(e);
      throw new RpcUnavailable("rpc");
    }
    const r: Result = { bytes: null, transient: false };
    if (meta.isMint) {
      try {
        if (meta.meta?.uri) r.bytes = await thumbFromUri(meta.meta.uri, deadline);
        else if (WELL_KNOWN[mint]) {
          const got = await safeGet(new URL(WELL_KNOWN[mint]), IMAGE_MAX, IMAGE_TIMEOUT_MS, deadline);
          if (sniffImage(got.body)) r.bytes = await toThumb(got.body);
        }
      } catch (e) {
        r.transient = e instanceof FetchFail && e.transient;
        // attacker-controlled hosts fail in all sorts of ways; one line is enough to debug a specific token
        console.log(JSON.stringify({ img: { mint: mint.slice(0, 6), host: (e as { host?: string })?.host, err: String((e as Error)?.message ?? e).slice(0, 80), transient: r.transient } }));
      }
    }
    keep(mint, r);
    return r;
  })();
  // Safety net: whatever a hostile host manages, the shared entry is released shortly after the budget, so later
  // requests for this mint never queue behind a job that can't finish. (The job's own slots are released by the
  // per-hop timers in getOnce.)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = Promise.race([
    job,
    new Promise<Result>((resolve) => { timer = setTimeout(() => resolve({ bytes: null, transient: true }), deadline - Date.now() + 1_000); }),
  ]).finally(() => { clearTimeout(timer); inflight.delete(mint); });
  job.catch(() => {}); // a late failure after the race was lost is already answered
  inflight.set(mint, p);
  return p;
}
