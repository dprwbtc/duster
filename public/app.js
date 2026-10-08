/* spacedust · sell your dust in one prompt
   Vanilla JS, no build step. Token names, symbols and icons are attacker-controlled: every string from the
   network goes into the DOM as a text node or an attribute via h(), never as HTML. */

/* ================= utilities ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SVGNS = "http://www.w3.org/2000/svg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = document.documentElement;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== "") el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ""));
function icon(name, cls = "i") {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVGNS, "use"); u.setAttribute("href", "#i-" + name);
  s.append(u); return s;
}
function svgEl(tag, attrs = {}, ...kids) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; }

const mq = matchMedia("(prefers-reduced-motion: reduce)");
const reduced = () => mq.matches || root.dataset.motion === "off";
const applyMotion = () => root.classList.toggle("rm", reduced());
mq.addEventListener("change", applyMotion); applyMotion();

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hash(str) { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
const short = (m) => (m ? m.slice(0, 4) + "…" + m.slice(-4) : "");
const store = {
  get(k, d) { try { const v = localStorage.getItem("duster." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { if (v == null) localStorage.removeItem("duster." + k); else localStorage.setItem("duster." + k, JSON.stringify(v)); } catch {} },
};

/* base64 and base58, for wallet bytes and locally derived signatures */
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function bytesToB64(b) { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
// A signed transaction starts with a compact-u16 signature count, then the 64-byte fee-payer signature,
// which is the transaction id. Knowing it lets us track a send even if the /api/send response never arrives.
function sigOf(b64) {
  try {
    const b = b64ToBytes(b64);
    let off = 1; if (b[0] & 0x80) off = b[1] & 0x80 ? 3 : 2;
    const sig = b.subarray(off, off + 64);
    return sig.length === 64 && sig.some((x) => x !== 0) ? b58(sig) : null;
  } catch { return null; }
}

/* ================= formatting ================= */
const usd = (n) => n == null || !Number.isFinite(n) ? "—" : n > 0 && n < 0.01 ? "<$0.01" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdP = (n) => n > 0 && n < 0.01 ? "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 2 }) : usd(n);
function amt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n === 0) return "0";
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}
function outAmt(n, o) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (o && STABLES.has(o.id)) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
  if (o && o.id === SOL && n < 1e4) return n.toLocaleString("en-US", n < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 4 });
  return amt(n);
}
const int = (n) => (n >= 1 ? Math.round(n).toLocaleString("en-US") : amt(n));
const plural = (n, w, p = w + "s") => `${typeof n === "number" ? n.toLocaleString("en-US") : n} ${n === 1 ? w : p}`;
const pct = (bps) => +(bps / 100).toFixed(2) + "%";
const RENT_SOL = 0.00203928; // rent held by a standard token account (Token-2022 accounts hold a bit more), returned when it's closed
// SOL from lamports: five decimals below 0.01 SOL, so one account's rent reads 0.00204 (four would round it to
// 0.0020 and the rows wouldn't add up to the total), four below 1 SOL, two above
function solAmt(lamports) {
  const n = (Number(lamports) || 0) / 1e9;
  if (n === 0) return "0";
  if (n < 0.00001) return "<0.00001";
  const d = n < 0.01 ? 5 : 4;
  return n.toLocaleString("en-US", { minimumFractionDigits: n < 1 ? d : 2, maximumFractionDigits: d });
}
// "≈ 0.0286 SOL" never breaks after the ≈
const solApprox = (lamports) => `≈ ${solAmt(lamports)}`;
// the same amount in dollars at the SOL price /api/config already returned (estimate only; no extra request)
const solUsd = (lamports) => { const p = state.prices?.[SOL]; return p > 0 && lamports > 0 ? usd((lamports / 1e9) * p) : null; };

/* ================= constants & state ================= */
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([USDC, USDT]);
const DEFAULT_OUTS = [
  { id: SOL, symbol: "SOL", name: "Solana", verified: true },
  { id: USDC, symbol: "USDC", name: "USD Coin", verified: true },
  { id: USDT, symbol: "USDT", name: "Tether USD", verified: true },
];
const MAX = 30;            // matches the server's per-plan and per-send limits
const CHUNK = 8;           // tokens per /api/plan request, so progress is real and no request nears the 60s limit
// How long a quote may be signed. Every swap carries its guaranteed minimum output, so an older quote can only fail
// on-chain (cheaply, at preflight), never fill worse than the minimum; blockhashes are refreshed right before signing.
const TTL_MS = 120_000;
const DEFAULT_SET = { slip: 1, loss: 10, close: true };
const PRESETS = [1, 2, 5, 10, 25, "all", "custom"];
const RC_MAX = 400;          // accounts per cleanup run, matching /api/reclaim's cap (about 16 transactions)
const RC_TTL_MS = 5 * 60_000; // a cleanup review older than this is checked again before signing
const RC_PAGE = 40;           // cleanup rows shown before "show more", so a 1,300-account wallet can reach what's below the list

const state = {
  scene: "title", epoch: 0, busy: null,
  fee: undefined, feeErr: false, prices: {},
  wallets: [], wallet: null, account: null, connecting: false, booted: false,
  rows: [], nftCount: 0, collectibleCount: 0, uncheckedCount: 0, selected: new Set(), loading: false, loadError: null, cooldownUntil: 0,
  preset: 2, range: { min: 0, max: 2 }, query: "", includeBurn: false,
  out: DEFAULT_OUTS[0], customAck: false,
  set: { ...DEFAULT_SET, ...sanitizeSet(store.get("set", {})) },
  plan: null, planAt: 0, building: null, stale: false, staleWhy: null, notice: null,
  run: null, pendingAccounts: null, tempLoss: null,
  rowsFor: null,   // the address the pockets list was last read for (the cleanup can be opened without it)
  rc: rcFresh(),   // the cleanup: rent reclaim from token accounts
  signing: null,   // "swap" | "reclaim" while a wallet prompt is being prepared or shown
  intent: null,    // "cleanup" when the landing's "just reclaim rent" asked for a wallet first
  cinemaN: 0,
};
function rcFresh() {
  return { accounts: null, owner: null, loading: false, error: null, at: 0, seq: 0, priced: false, priceError: false, pricing: false, pricingError: null,
    sel: new Set(), burnSel: new Set(), burnAck: false, burnOpen: false, plan: null, building: null, notice: null, resetSel: false, pendingSel: null, built: null, inputs: new Map(),
    showN: RC_PAGE, nftShowN: RC_PAGE, from: null };
}
// Dev/QA helpers, only ever loaded on localhost (see boot). Whether dev mode was asked for is decided before
// any wallet can register, so a real wallet that registers while dev.js is still loading can't slip past its filter.
const params = new URLSearchParams(location.search);
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const DEV_REQ = LOCAL && (params.has("demo") || params.has("watch"));
let dev = null, devSettled = !DEV_REQ;
const walletFilter = (w) => (!devSettled ? false : dev?.walletFilter ? dev.walletFilter(w) : true);

function sanitizeSet(s) {
  const o = {};
  if (Number.isFinite(s.slip) && s.slip >= 0.1 && s.slip <= 20) o.slip = s.slip;
  if (Number.isFinite(s.loss) && s.loss >= 0 && s.loss <= 50) o.loss = s.loss;
  if (typeof s.close === "boolean") o.close = s.close;
  return o;
}

const fee = () => state.fee || null;
const burnId = () => fee()?.burnToken.id ?? null;
const burnOut = () => fee() ? { ...fee().burnToken, burn: true } : null;
const isBurnOut = (o = state.out) => !!burnId() && o.id === burnId();
const feeOn = (o = state.out) => !!fee() && !isBurnOut(o);
const outs = () => [...DEFAULT_OUTS, ...(fee() ? [burnOut()] : [])];
const isCustomOut = () => !outs().some((o) => o.id === state.out.id);
// an unverified custom output never wears the same label as the real token it may be copying
const unverifiedOut = (o = state.out) => !!o && !o.verified && !outs().some((x) => x.id === o.id);
const symOf = (o) => (o && isBurnOut(o) ? "$" + o.symbol : unverifiedOut(o) ? `${o.symbol || short(o.id)} · unverified` : o?.symbol || short(o?.id));
const burnSym = () => (fee() ? "$" + fee().burnToken.symbol : "the burn token");
const outPrice = (o = state.out) => (typeof o.usdPrice === "number" ? o.usdPrice : state.prices[o.id] ?? null);

const rowBy = (mint) => state.rows.find((r) => r.mint === mint);
// the server's non-fungible kinds a person would call an NFT; "sft" and "collectible" are called collectibles
const isNftKind = (k) => k === "nft" || k === "pnft" || k === "edition" || k === "t22-nft";
const isBurnRow = (r) => !!burnId() && r.mint === burnId();
const burnHidden = (r) => isBurnRow(r) && !state.includeBurn;
const selectable = (r) => r.usd != null && !r.frozen && r.mint !== state.out.id && !burnHidden(r);
const inRange = (r) => r.usd != null && r.usd >= state.range.min && r.usd <= state.range.max;
function shown() {
  const q = state.query.trim().toLowerCase();
  return state.rows.filter((r) => r.usd != null && !burnHidden(r) && r.mint !== state.out.id &&
    (state.preset === "all" || inRange(r)) &&
    (!q || (r.symbol || "").toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q) || r.mint.toLowerCase().startsWith(q)));
}
const selRows = () => state.rows.filter((r) => state.selected.has(r.mint));
const totalUsd = () => selRows().reduce((s, r) => s + (r.usd || 0), 0);
const estFeeUsd = () => (feeOn() ? totalUsd() * (fee().bps / 10_000) : 0);
function estOut(o = state.out, usdIn = totalUsd()) {
  const p = outPrice(o); if (!p) return null;
  return (usdIn * (feeOn(o) ? 1 - fee().bps / 10_000 : 1)) / p;
}

/* ================= API ================= */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(path, body, { signal } = {}) {
  if (dev?.api) { const r = await dev.api(path, body, { signal }); if (r !== undefined) return r; }
  let res;
  try {
    res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, cache: "no-store" } : { signal, cache: "no-store" });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("Couldn’t reach Spacedust. Check your connection and try again.", 0);
  }
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok || j === null) {
    // a rate limit is Spacedust's problem, not the user's; the UI shows the exact wait next to it
    const msg = res.status === 429 ? "Spacedust is busy right now. Try again when the timer runs out."
      : j?.error || (res.status === 504 ? "The server timed out. Try fewer tokens at once." : `Request failed (${res.status}).`);
    throw new ApiError(/[.!?]$/.test(msg) ? msg : msg + ".", res.status);
  }
  return j;
}

/* ================= scene control ================= */
const SCENES = { title: ["sc. 00", "title", 0], pockets: ["sc. 01", "the pockets", 1], cleanup: ["sc. 01", "the cleanup", 1], sweep: ["sc. 02", "the sweep", 2], cut: ["sc. 02", "the cut", 2], wallet: ["sc. 03", "your move", 3], drop: ["sc. 04", "the drop", 4] };
let currentVT = null;
function vt(update, types = []) {
  if (!document.startViewTransition || reduced() || document.hidden) { update(); return Promise.resolve(); }
  try { currentVT?.skipTransition(); } catch {}
  let t;
  try { t = document.startViewTransition({ update, types }); } catch { t = document.startViewTransition(update); }
  currentVT = t;
  t.ready.catch(() => {}); t.finished.catch(() => {}).then(() => { if (currentVT === t) currentVT = null; });
  return t.updateCallbackDone.catch(() => {});
}
function go(scene, { back = false, instant = false } = {}) {
  const apply = () => {
    state.scene = scene;
    root.dataset.scene = scene;
    if (scene !== "title") root.classList.remove("bar-cta");
    for (const s of $$(".scene")) s.hidden = s.dataset.scene !== scene;
    window.scrollTo({ top: 0, behavior: "instant" });
    // the list may have changed while another scene was showing (background refresh, output change)
    if (scene === "pockets" && !state.loading && !state.loadError && state.rows.length) { syncRows(); renderPocketsMeta(); renderAside(); requestAnimationFrame(movePresetThumb); }
    if (scene === "pockets") renderRentCard();
    if (scene === "cleanup") renderCleanup();
    renderSlate(); renderBar();
  };
  if (instant || state.scene === scene) { apply(); return Promise.resolve(); }
  return vt(apply, [back ? "back" : "forward"]);
}
function renderSlate() {
  // the cleanup's review is its own beat (sc. 02), like the cut is for swaps
  const key = root.classList.contains("cinema-on") ? "wallet" : state.scene === "cleanup" && (state.rc.plan || state.rc.building) ? "sweep" : state.scene;
  const [num, name, idx] = SCENES[key];
  $("#slateNum").textContent = num;
  $("#slateName").textContent = name;
  $$("#slateTicks i").forEach((t, i) => { t.className = i + 1 === idx ? "on" : i + 1 < idx ? "done" : ""; });
}

/* subtitles (decorative, aria-hidden) and the screen-reader status line */
let lastCap = "";
function caption(text) {
  if (text === lastCap) return;
  lastCap = text;
  const el = $("#subtitle");
  el.replaceChildren();
  if (reduced()) { el.textContent = text; return; }
  text.split(" ").forEach((w, i) => { el.append(h("span", { class: "w", style: `animation-delay:${i * 45}ms` }, w), " "); });
}
let srT;
function srSay(text) { const el = $("#srStatus"); clearTimeout(srT); el.textContent = ""; srT = setTimeout(() => { el.textContent = text; }, 60); }

/* ================= mascot ================= */
const POSE_DIMS = { 1: [191, 326], 2: [246, 326], 3: [245, 325], 4: [160, 321], 5: [303, 325], 6: [242, 317], 7: [259, 334], 8: [252, 312], 9: [248, 314], 10: [285, 309], 11: [308, 314], 12: [274, 312], 13: [212, 312], 14: [262, 321], 15: [263, 318], 16: [259, 320], 17: [189, 319], 18: [261, 321], 19: [222, 322] };
const pose = (n) => `/img/dusty/pose-${String(n).padStart(2, "0")}.webp`;
function setPose(btn, n, { mode = "idle", hop = true } = {}) {
  if (!btn) return;
  const img = btn.querySelector("img");
  const src = pose(n);
  btn.classList.remove("idle", "wiggle", "jump", "hop");
  const finish = () => {
    if (reduced()) return;
    void btn.offsetWidth;
    if (mode === "jump") btn.classList.add("jump");
    else if (mode === "wiggle") btn.classList.add("wiggle");
    else if (hop) { btn.classList.add("hop"); setTimeout(() => { btn.classList.remove("hop"); if (mode === "idle") btn.classList.add("idle"); }, 440); }
    else if (mode === "idle") btn.classList.add("idle");
  };
  clearTimeout(btn._pt);
  if (img.getAttribute("src") === src && img.style.opacity !== "0") return finish();
  const swap = () => {
    const [w, hh] = POSE_DIMS[n] || [254, 334];
    img.width = w; img.height = hh; img.src = src;
    const rim = btn.querySelector(".m-rim"); if (rim) rim.style.setProperty("--pose", `url("${src}")`);
    img.style.opacity = "1"; finish();
  };
  if (!img.getAttribute("src") || reduced()) return swap();
  img.style.opacity = "0";
  btn._pt = setTimeout(swap, 140);
}
const sceneMascot = (scene = state.scene) => $(`.scene[data-scene="${scene}"] [data-mascot]`);
let reactTimer;
function react(n, back, ms = 1100) {
  const m = sceneMascot(); if (!m) return;
  clearTimeout(reactTimer);
  setPose(m, n);
  reactTimer = setTimeout(() => setPose(m, back, { hop: false }), ms);
}
function boop(btn) {
  btn.classList.add("booped");
  const before = btn.querySelector("img").getAttribute("src");
  setPose(btn, 8);
  clearTimeout(btn._b);
  btn._b = setTimeout(() => { btn.classList.remove("booped"); const n = Number((before || "").match(/pose-(\d+)/)?.[1]); if (n) setPose(btn, n, { hop: false }); }, 1300);
}

/* ================= toasts (die-cut stickers) ================= */
const toastsEl = $("#toasts");
function toast({ title, body, tone = "neutral", actions = [], timeout = tone === "bad" ? 0 : 5600 }) {
  const ic = tone === "bad" ? "warn" : tone === "ok" ? "check" : "info";
  const t = h("div", { class: "toast " + tone, role: tone === "bad" ? "alert" : "status" },
    icon(ic, "i t-ico"),
    h("div", {}, h("p", { class: "t-title" }, title), body && h("p", { class: "t-body" }, body),
      actions.length > 0 && h("div", { class: "t-act" }, actions.map((a) => h("button", { class: "btn-ghost sm", type: "button", onclick: () => { dismiss(); a.run(); } }, a.label)))),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Dismiss", onclick: () => dismiss() }, icon("x")));
  const dismiss = () => {
    if (!t.isConnected) return;
    t.classList.add("leaving");
    setTimeout(() => { t.remove(); if (!toastsEl.children.length) try { toastsEl.hidePopover(); } catch {} }, reduced() ? 0 : 200);
  };
  toastsEl.append(t);
  while (toastsEl.children.length > 3) toastsEl.firstElementChild.remove();
  // re-show so the toast layer stays above any popover opened since
  try { if (toastsEl.matches(":popover-open")) toastsEl.hidePopover(); toastsEl.showPopover(); } catch {}
  srSay(typeof body === "string" ? `${title}. ${body}` : title);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}
function clearToasts() { toastsEl.replaceChildren(); try { toastsEl.hidePopover(); } catch {} }

/* ================= popovers ================= */
// Native popovers (light dismiss, Esc, top layer). Placement: CSS anchor positioning when supported,
// measured otherwise. Phones get bottom sheets from CSS.
const anchorOK = CSS.supports?.("anchor-name: --a") && CSS.supports?.("position-area: block-end");
let anchorN = 0, lastInvoker = null;
function placePopover(pop, invoker) {
  if (!invoker || innerWidth <= 640) { pop.style.cssText = ""; return; }
  const r = invoker.getBoundingClientRect();
  // keep clear of the letterbox bars; open on whichever side has room for the content, and cap the height
  // to that room so the popover scrolls inside itself instead of running off screen
  const topEdge = $("#barTop").getBoundingClientRect().bottom + 8, botEdge = $("#barBot").getBoundingClientRect().top - 8;
  const below = botEdge - r.bottom - 8, above = r.top - topEdge - 8;
  const need = pop.matches(":popover-open") ? pop.scrollHeight : 0;
  const up = need ? need > below && above > below : r.top > innerHeight * 0.55;
  const room = Math.max(160, Math.floor(up ? above : below));
  pop.classList.toggle("up", up);
  pop.style.maxHeight = room + "px";
  const rightSide = r.left > innerWidth * 0.55;
  if (anchorOK) {
    if (!invoker.style.anchorName) invoker.style.anchorName = "--pa" + ++anchorN;
    pop.style.positionAnchor = invoker.style.anchorName;
    pop.style.positionArea = `${up ? "block-start" : "block-end"} ${rightSide ? "span-inline-start" : "span-inline-end"}`;
    pop.style.positionTryFallbacks = "flip-inline";
    pop.style.margin = "8px 0";
    return;
  }
  const w = pop.offsetWidth || 340, hgt = Math.min(pop.offsetHeight || 200, room);
  let left = rightSide ? r.right - w : r.left;
  left = Math.max(12, Math.min(left, innerWidth - w - 12));
  const top = up ? Math.max(topEdge, r.top - hgt - 8) : Math.min(r.bottom + 8, botEdge - hgt);
  Object.assign(pop.style, { left: left + "px", top: top + "px", right: "auto", bottom: "auto" });
}
document.addEventListener("click", (e) => { const b = e.target.closest("[popovertarget]"); if (b) lastInvoker = b; }, true);
for (const pop of $$("[popover].pop")) {
  pop.addEventListener("beforetoggle", (e) => {
    if (e.newState !== "open") return;
    // inputs stay locked while a preview builds or the wallet is signing
    if (state.busy && ["setPop", "outPop", "rangePop", "burnPop"].includes(pop.id)) { e.preventDefault(); return; }
    const inv = e.source || lastInvoker || pop._invoker;
    pop._invoker = inv;
    if (pop.id === "outPop") renderOutPop();
    if (pop.id === "setPop") syncSettingsForm();
    if (pop.id === "burnPop") renderBurnPop();
    if (pop.id === "rangePop") { $("#fMin").value = state.range.min; $("#fMax").value = state.range.max === Infinity ? "" : state.range.max; }
    placePopover(pop, inv);
    requestAnimationFrame(() => placePopover(pop, inv));
  });
  pop.addEventListener("toggle", (e) => { if (e.newState === "closed" && pop._invoker?.isConnected && pop.contains(document.activeElement)) pop._invoker.focus({ preventScroll: true }); });
}
function openPop(id, invoker) {
  const pop = $("#" + id);
  pop._invoker = invoker; lastInvoker = invoker;
  try { pop.showPopover({ source: invoker }); } catch { try { pop.showPopover(); } catch {} }
}
const closePop = (id) => { try { $("#" + id).hidePopover(); } catch {} };
function closeAllPops() { for (const p of $$("[popover]")) if (p.id !== "toasts" && !p.dataset.keep) try { p.hidePopover(); } catch {} }

/* ================= hero still: procedural dusk, star trails, skyline ================= */
function buildTrails() {
  const svg = $("#trails"), W = 1600, H = 900, cx = W * 0.82, cy = -H * 0.22, r = rng(9);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const g = svgEl("g", { class: "orbit", style: `transform-origin:${cx}px ${cy}px` });
  // one exposure: every star sweeps the same angle, which is what makes it read as a long exposure
  for (let i = 0; i < 190; i++) {
    const rad = 40 + Math.pow(r(), 0.7) * 1500;
    const a0 = r() * 360, len = 19 + r() * 3;
    const p = (a) => [cx + rad * Math.cos((a * Math.PI) / 180), cy + rad * Math.sin((a * Math.PI) / 180)];
    const [x1, y1] = p(a0), [x2, y2] = p(a0 + len);
    const t = r();
    const col = t > 0.9 ? "#F4CE7F" : t > 0.82 ? "#9CC8FF" : t > 0.78 ? "#E89EA4" : "#ffffff";
    const op = (0.04 + Math.pow(r(), 2.6) * 0.42).toFixed(3);
    g.append(svgEl("path", { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} A${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`, fill: "none", stroke: col, "stroke-opacity": op, "stroke-width": (0.7 + r() * 1.1).toFixed(2), "stroke-linecap": "round" }));
  }
  g.append(svgEl("circle", { cx, cy: cy + 4, r: 2, fill: "#fff", opacity: ".8" }));
  svg.append(g);
}
function buildSkyline(svg, { seed, H, minH, maxH, fill: color, windows }) {
  const W = 1600, r = rng(seed);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let d = `M0 ${H}`, x = 0, win = "";
  while (x < W) {
    const w = 14 + r() * 58, bh = minH + Math.pow(r(), 1.8) * (maxH - minH), top = H - bh;
    d += ` L${x.toFixed(1)} ${top.toFixed(1)}`;
    if (r() > 0.78) { const ax = x + w * (0.3 + r() * 0.4), at = (top - 10 - r() * 26).toFixed(1); d += ` L${ax.toFixed(1)} ${top.toFixed(1)} L${ax.toFixed(1)} ${at} L${(ax + 1.6).toFixed(1)} ${at} L${(ax + 1.6).toFixed(1)} ${top.toFixed(1)}`; }
    if (r() > 0.85) d += ` L${(x + w * 0.5).toFixed(1)} ${(top - 8).toFixed(1)}`;
    d += ` L${(x + w).toFixed(1)} ${top.toFixed(1)}`;
    if (windows) for (let yy = top + 6; yy < H - 4; yy += 7) for (let xx = x + 4; xx < x + w - 4; xx += 6) if (r() > 0.93) win += `M${xx.toFixed(1)} ${yy.toFixed(1)}h2v3h-2z`;
    x += w + (r() > 0.7 ? r() * 8 : 0);
  }
  d += ` L${W} ${H} Z`;
  svg.append(svgEl("path", { d, fill: color }));
  if (win) svg.append(svgEl("path", { d: win, fill: "#F4CE7F", opacity: ".55" }));
}
function buildStill() {
  buildTrails();
  buildSkyline($("#skyFar"), { seed: 31, H: 260, minH: 40, maxH: 210, fill: "#2a1b2b", windows: false });
  buildSkyline($("#skyNear"), { seed: 5, H: 220, minH: 30, maxH: 170, fill: "#0a0710", windows: true });
  $("#heroMascot .m-rim").style.setProperty("--pose", `url("${pose(2)}")`);
}

/* the gold nameplate: script text with a specular bevel, hung from Cuban links that reach up into the top bar */
async function drawNameplate() {
  const svg = $("#plateSvg"), text = $("#plateText");
  try { await Promise.race([document.fonts.load('400 196px "Mr Dafoe"'), sleep(2500)]); } catch {}
  let bb = text.getBBox();
  if (bb.width > 0) {
    text.style.fontSize = Math.min(240, 196 * (560 / bb.width)) + "px";
    bb = text.getBBox();
    text.setAttribute("y", String(Number(text.getAttribute("y")) - (bb.y - 10)));
    bb = text.getBBox();
    svg.setAttribute("viewBox", `0 0 640 ${Math.ceil(bb.y + bb.height + 18)}`);
  }
  const chain = $("#plateChain"), rings = $("#plateRings");
  chain.replaceChildren(); rings.replaceChildren();
  const attachY = bb.y + bb.height * 0.34;
  const L = { x: bb.x + bb.width * 0.06, y: attachY + 6 }, R = { x: bb.x + bb.width * 0.94, y: attachY - 4 };
  const TOP = -1100;
  for (const end of [L, R]) {
    const outward = end === L ? -1 : 1;
    const p = svgEl("path", { d: `M${end.x + outward * 18} ${TOP}Q${end.x + outward * 26} ${end.y - 260} ${end.x} ${end.y}` });
    chain.append(p);
    const len = p.getTotalLength(), step = 8.6, n = Math.floor(len / step);
    p.remove();
    const frag = document.createDocumentFragment();
    for (let i = 0; i <= n; i++) {
      const d = Math.min(len, i * step), pt = p.getPointAtLength(d), pt2 = p.getPointAtLength(Math.min(len, d + 0.5));
      const ang = (Math.atan2(pt2.y - pt.y, pt2.x - pt.x) * 180) / Math.PI + (i % 2 ? 24 : -24);
      frag.append(svgEl("g", { transform: `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)}) rotate(${ang.toFixed(1)})` },
        svgEl("ellipse", { class: "chain-shade", rx: "6.6", ry: "3.7" }),
        svgEl("ellipse", { class: "chain-link", rx: "6.6", ry: "3.7" }),
        svgEl("path", { class: "chain-hi", d: "M-4 -2.5Q0 -3.9 4 -2.5" })));
    }
    chain.append(frag);
    rings.append(svgEl("circle", { cx: end.x.toFixed(1), cy: end.y.toFixed(1), r: "5", fill: "none", stroke: "url(#g-gold)", "stroke-width": "2.6" }));
  }
  const gl = $("#plateGlint");
  gl.setAttribute("x", (bb.x + bb.width * 0.22 - 13).toFixed(1));
  gl.setAttribute("y", (bb.y + bb.height * 0.06).toFixed(1));
  if (reduced() || root.classList.contains("revisit")) { svg.classList.add("ready"); return; }
  svg.classList.remove("swing"); void svg.getBoundingClientRect(); svg.classList.add("swing");
  svg.addEventListener("animationend", () => svg.classList.add("ready"), { once: true });
}
function openingShutter() {
  const t = $("#shutterTop"), b = $("#shutterBot");
  if (reduced() || !t.animate || root.classList.contains("revisit")) { t.remove(); b.remove(); return; }
  const half = innerHeight / 2;
  const st = $("#barTop").offsetHeight / half, sb = $("#barBot").offsetHeight / half;
  const opts = { duration: 1000, delay: 250, easing: "cubic-bezier(.7,0,.2,1)", fill: "forwards" };
  t.animate([{ transform: "scaleY(1)" }, { transform: `scaleY(${st})` }], opts).finished.then(() => t.remove(), () => t.remove());
  b.animate([{ transform: "scaleY(1)" }, { transform: `scaleY(${sb})` }], opts).finished.then(() => b.remove(), () => b.remove());
}

/* ================= wallets (Wallet Standard, no SDK) ================= */
const usable = (w) => !!w?.features?.["standard:connect"] && !!w.features["solana:signTransaction"] && walletFilter(w);
const registry = {
  register(...ws) {
    for (const w of ws) {
      if (!w || state.wallets.includes(w)) continue;
      state.wallets.push(w);
      // silent reconnect to the wallet used last time (no popup; the wallet decides if it's still authorized)
      if (usable(w) && !state.account && store.get("wallet") === w.name) setTimeout(() => { if (!state.account && !state.connecting) connect(w, { silent: true }); }, 0);
    }
    if ($("#walletDlg").open && !dialogConnecting()) openWallets();
    return () => {};
  },
};
window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(registry); } catch {} });

const walletIcon = (w) => typeof w.icon === "string" && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(w.icon) && w.icon.length < 200_000 ? w.icon : null;
function identicon(addr) {
  const hh = hash(addr) % 360;
  return `conic-gradient(from ${hash(addr + "x") % 360}deg, hsl(${hh} 55% 62%), hsl(${(hh + 70) % 360} 50% 40%), hsl(${(hh + 160) % 360} 55% 58%), hsl(${hh} 55% 62%))`;
}
function renderTop() {
  const on = !!state.account;
  $("#walletChip").hidden = !on;
  $("#walletChip").disabled = !!state.busy;
  $("#topConnect").hidden = on || state.scene !== "title";
  $("#heroConnect").firstElementChild.textContent = on ? "back to your dust" : "connect wallet";
  if (!on) return;
  const a = state.account.address;
  $("#walletAddr").textContent = short(a);
  $("#walletIdn").style.background = identicon(a);
  $("#walletChip").setAttribute("aria-label", `Wallet ${short(a)}, connected with ${state.wallet.name}. Open wallet menu`);
  $("#wpWith").textContent = "connected with " + state.wallet.name;
  $("#wpAddr").textContent = a;
  $("#wpSolscan").href = "https://solscan.io/account/" + encodeURIComponent(a);
}

// The picker can always be closed, and another wallet picked, even while a connect is pending: a wallet whose
// connect() never settles must not lock the page. Each attempt carries a number; a late answer from an
// abandoned attempt is ignored.
const dlg = $("#walletDlg");
let connectSeq = 0, connectTimer = null;
const dialogConnecting = () => state.connecting && !state.connectingSilent;
function abandonConnect() {
  if (!state.connecting) return;
  connectSeq++; state.connecting = false; state.connectingSilent = false; clearTimeout(connectTimer);
}
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener("close", () => { if (dialogConnecting()) abandonConnect(); if (!state.account) state.intent = null; });
$$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));

function deepLinks() {
  const url = encodeURIComponent(location.href.split("#")[0]), ref = encodeURIComponent(location.origin);
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${url}?ref=${ref}`, install: "https://phantom.com/download" },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`, install: "https://solflare.com/download" },
    { name: "Backpack", href: `https://backpack.app/ul/v1/browse/${url}?ref=${ref}`, install: "https://backpack.app/downloads" },
  ];
}
const LETTER_BG = { Phantom: ["#ab9ff2", "#1b1530"], Solflare: ["#fc7227", "#1a0d02"], Backpack: ["#e33e3f", "#fff"] };
function openWallets({ note = null } = {}) {
  closeAllPops();
  const body = $("#wdBody");
  const list = state.wallets.filter(usable);
  if (!list.length && !state.booted) {
    // wallets register asynchronously; give them a moment before saying none were found
    $("#wd-title").textContent = "pick your wallet";
    fill(body, h("p", { class: "wd-note", role: "status" }, h("span", { class: "spin" }), "Looking for wallets in this browser…"));
    if (!dlg.open) dlg.showModal();
    return;
  }
  if (!list.length) {
    const mobile = matchMedia("(pointer: coarse)").matches;
    $("#wd-title").textContent = "no wallet found";
    fill(body,
      h("p", { class: "facts" }, mobile ? "This browser doesn’t have a Solana wallet. Open Spacedust inside your wallet app’s browser instead:" : "This browser doesn’t have a Solana wallet extension. Install one, then reload this page."),
      mobile && h("div", { class: "deep", style: "margin-top:14px" }, deepLinks().map((w) => h("a", { class: "w-opt", href: w.href, rel: "noreferrer" },
        h("span", { class: "w-ico", style: `background:${LETTER_BG[w.name][0]};color:${LETTER_BG[w.name][1]}` }, w.name[0]),
        h("span", {}, h("span", { class: "w-name" }, `open in ${w.name}`), h("span", { class: "w-sub" }, "opens this page in the wallet app")),
        icon("ext", "i i-sm")))),
      h("p", { class: "wd-group" }, "install a wallet"),
      h("div", { class: "deep" }, deepLinks().map((w) => h("a", { class: "w-opt", href: w.install, target: "_blank", rel: "noreferrer" },
        h("span", { class: "w-ico", style: `background:${LETTER_BG[w.name][0]};color:${LETTER_BG[w.name][1]}` }, w.name[0]),
        h("span", {}, h("span", { class: "w-name" }, w.name), h("span", { class: "w-sub" }, "official download page")),
        icon("ext", "i i-sm")))),
      h("p", { class: "wd-fine" }, "Works with any Wallet Standard wallet that can sign Solana transactions."));
  } else {
    $("#wd-title").textContent = "pick your wallet";
    fill(body,
      h("div", { class: "wl" }, list.map((w) => {
        const ic = walletIcon(w);
        return h("button", { class: "w-opt", type: "button", "data-w": w.name, onclick: () => connect(w) },
          h("span", { class: "w-ico" }, ic ? h("img", { src: ic, alt: "", width: "40", height: "40" }) : (w.name || "?")[0]),
          h("span", { style: "min-width:0" }, h("span", { class: "w-name" }, w.name || "Wallet"), h("span", { class: "w-sub" }, "ready in this browser")),
          h("span", { class: "w-tag" }, icon("spark", "i i-sm"), "detected"));
      })),
      note,
      h("p", { class: "wd-fine" }, "Works with Phantom, Solflare, Backpack and other Wallet Standard wallets. Connecting is read-only: Spacedust sees your address and balances. Nothing is signed until you approve it in your wallet."));
  }
  if (!dlg.open) dlg.showModal();
}
const isReject = (e) => e?.code === 4001 || /reject|cancel|denied|declined|closed|user/i.test(String(e?.message || e?.name || ""));
async function connect(w, { silent = false } = {}) {
  if (state.busy || (silent && state.connecting)) return;
  abandonConnect(); // picking a wallet while another connect is pending replaces that attempt
  const ep = state.epoch, attempt = ++connectSeq;
  state.connecting = true; state.connectingSilent = silent;
  if (!silent) {
    $$(".w-opt", dlg).forEach((b) => {
      b.classList.toggle("connecting", b.dataset.w === w.name);
      if (b.dataset.w && b.dataset.w !== w.name && b.lastElementChild.classList.contains("no")) b.lastElementChild.replaceWith(h("span", { class: "w-tag" }, icon("spark", "i i-sm"), "detected"));
    });
    const btn = $$(".w-opt", dlg).find((b) => b.dataset.w === w.name);
    btn?.lastElementChild.replaceWith(h("span", { class: "w-tag no" }, h("span", { class: "spin" }), "approve in wallet"));
    $$(".wd-note", dlg).forEach((n) => n.remove());
    connectTimer = setTimeout(() => {
      if (attempt !== connectSeq || !dlg.open) return;
      abandonConnect();
      openWallets({ note: h("p", { class: "wd-note neutral", role: "status" }, icon("info"), `Didn’t hear back from ${w.name || "the wallet"}. Open it, unlock it, and pick it again, or pick another wallet.`) });
    }, 60_000);
  }
  let accounts;
  try {
    ({ accounts } = await w.features["standard:connect"].connect(silent ? { silent: true } : undefined));
  } catch (e) {
    if (attempt !== connectSeq) return; // abandoned: the user closed the picker or picked another wallet
    abandonConnect();
    if (silent) return;
    openWallets({ note: isReject(e)
      ? h("p", { class: "wd-note neutral", role: "status" }, icon("info"), "Cancelled in wallet. Nothing happened. Pick a wallet to try again.")
      : h("p", { class: "wd-note bad", role: "alert" }, icon("warn"), `Couldn’t connect: ${String(e?.message || e).slice(0, 160)}`) });
    return;
  }
  if (attempt !== connectSeq) return;
  abandonConnect();
  if (ep !== state.epoch || state.busy) return;
  const acc = (accounts || []).find((a) => a.chains?.some((c) => c.startsWith("solana:"))) || accounts?.[0];
  if (!acc) { if (!silent) openWallets({ note: h("p", { class: "wd-note neutral", role: "status" }, icon("info"), "The wallet didn’t share an account. Unlock it and try again.") }); return; }
  setAccount(w, acc);
  store.set("wallet", w.name);
  if (dlg.open) dlg.close();
  // "just reclaim rent" on the landing goes straight to the cleanup; the pockets load when visited
  const intent = state.intent; state.intent = null;
  if (intent === "cleanup") { state.rc.resetSel = true; state.rc.from = "title"; await go("cleanup"); loadAccounts(); return; }
  await go("pockets");
  loadHoldings();
}
function setAccount(w, acc) {
  if (state.wallet !== w) {
    state.walletOff?.();
    state.walletOff = w.features["standard:events"]?.on?.("change", (ch) => onWalletChange(w, ch)) || null;
  }
  if (state.account?.address !== acc.address) state.includeBurn = false; // the burn-token opt-in is per account
  state.wallet = w; state.account = acc;
  renderTop();
}
function onWalletChange(w, { accounts } = {}) {
  if (w !== state.wallet || !accounts) return;
  if (accounts.some((a) => a.address === state.account?.address)) { state.pendingAccounts = null; return; }
  // never swap the account out from under a build, a signature or a send: remember it and apply it as soon as
  // the app is idle (approve() also checks the live wallet before it asks for a signature)
  if (state.busy) { state.pendingAccounts = { w, accounts }; return; }
  state.pendingAccounts = null;
  if (!accounts.length) return disconnect({ quiet: true });
  setAccount(w, accounts[0]);
  toast({ title: "switched account", body: "Reloading balances for the account your wallet switched to." });
  state.plan = null; state.run = null; state.stale = false; stopRing();
  state.rc = rcFresh(); state.rowsFor = null;
  go("pockets").then(() => loadHoldings());
}
// every path that ends a busy phase goes through here, so a deferred account switch is never lost
function setIdle() {
  state.busy = null; state.signing = null;
  if (state.pendingAccounts) { const { w, accounts } = state.pendingAccounts; setTimeout(() => { if (!state.busy && state.pendingAccounts) onWalletChange(w, { accounts }); }, 0); }
}
function liveAccountOk(addr) {
  const live = state.wallet?.accounts;
  return !Array.isArray(live) || !live.length || live.some((a) => a.address === addr);
}
function disconnect({ quiet = false } = {}) {
  if (state.busy === "signing" || state.busy === "sending") return;
  state.epoch++;
  state.building?.ctrl?.abort();
  closeAllPops(); hideCinema(true); stopRing();
  try { state.wallet?.features["standard:disconnect"]?.disconnect(); } catch {}
  state.walletOff?.(); state.walletOff = null;
  store.set("wallet", null);
  state.wallet = state.account = null; state.rows = []; state.nftCount = state.collectibleCount = state.uncheckedCount = 0; state.selected.clear(); state.plan = null; state.run = null; state.building = null; state.busy = null;
  state.pendingAccounts = null; state.includeBurn = false; state.stale = false;
  state.rc = rcFresh(); state.rowsFor = null; state.intent = null;
  for (const el of rowEls.values()) el.remove(); rowEls.clear();
  root.classList.add("revisit");
  go("title", { back: true });
  if (!quiet) toast({ title: "disconnected. come back dusty", body: "Spacedust no longer sees this wallet." });
}
$("#heroConnect").addEventListener("click", () => (state.account ? go("pockets") : openWallets()));
// "just reclaim rent": works without any sellable dust; asks for a wallet first when none is connected
function reclaimEntry() {
  if (state.busy) return;
  if (state.account) return openCleanup();
  state.intent = "cleanup";
  openWallets();
}
$$("[data-reclaim]").forEach((b) => b.addEventListener("click", reclaimEntry));
$("#topConnect").addEventListener("click", () => openWallets());
$("#wpDisconnect").addEventListener("click", () => disconnect());
$("#wpSwitch").addEventListener("click", () => { closePop("walletPop"); openWallets(); });
$("#brand").addEventListener("click", (e) => {
  e.preventDefault();
  if (state.busy) return;
  if (state.scene === "title") window.scrollTo({ top: 0 });
  else { root.classList.add("revisit"); go("title", { back: true }); }
});
for (const [ev, n, hop] of [["mouseenter", 9, true], ["mouseleave", 2, false], ["focus", 9, true], ["blur", 2, false]])
  $("#heroConnect").addEventListener(ev, () => setPose($("#heroMascot"), n, { hop }));

/* ================= config (fee + prices) ================= */
async function loadConfig() {
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await api("/api/config");
      state.fee = c.fee && c.fee.burnToken?.id ? c.fee : null;
      state.prices = c.prices && typeof c.prices === "object" ? c.prices : {};
      state.jupRps = Number(c.jupRps) || 1;
      state.feeErr = false;
      break;
    } catch {
      // one quiet retry before falling back: without the config the burn token can't be kept out of the list
      if (attempt === 0) { await sleep(1500); continue; }
      state.fee = null; state.feeErr = true;
      break;
    }
  }
  const saved = store.get("out", null);
  const o = outs().find((x) => x.id === saved);
  if (o) state.out = o;
  else if (saved && saved === burnId()) state.out = burnOut();
  renderFeeCopy();
  // the burn token is never picked for you; drop it if holdings arrived before the fee settings did
  for (const m of [...state.selected]) { const r = rowBy(m); if (!r || !selectable(r)) state.selected.delete(m); }
  if (state.scene === "pockets") { syncRows(); renderPocketsMeta(); renderAside(); }
  renderBar();
}
function renderFeeCopy() {
  const f = fee();
  $("#heroFacts").textContent = f
    ? `Pick up to 30 small tokens and swap them into SOL, USDC or USDT. Your wallet asks once. Each swap also buys and burns ${pct(f.bps)} in ${burnSym()}, in the same transaction.`
    : state.feeErr ? "Pick up to 30 small tokens and swap them into SOL, USDC or USDT. Your wallet asks once. Any fee is shown in the review before you sign."
    : "Pick up to 30 small tokens and swap them into SOL, USDC or USDT. Your wallet asks once for all of them.";
  $("#linerBurn").hidden = !f;
  const ff = $("#feeFine");
  ff.hidden = !f;
  if (f) {
    $("#linerBurnTitle").textContent = `${pct(f.bps)} fee, bought and burned`;
    $("#linerBurnText").textContent = `Each transaction swaps your token, then uses ${pct(f.bps)} of its minimum guaranteed output to buy ${burnSym()} and burn it, in the same transaction. Nobody receives the fee, and every burn is visible on-chain. If a swap fails, no fee is taken. Swapping into ${burnSym()} has no fee.`;
    $("#linerMint").textContent = f.burnToken.id;
    fill(ff, h("b", {}, "Fee. "), `The ${pct(f.bps)} fee buys a token this project may hold. It is a mechanism, not a promise about price. Check the burn mint address above: several tokens copy the name.`);
  }
}

/* ================= bottom bar: subtitles + the one action ================= */
const cta = $("#cta"), ctaLabel = $("#ctaLabel"), ctaAlt = $("#ctaAlt");
let ctaAction = null, ctaAltAction = null;
function setCta(label, { action = null, disabled = false, busy = false, alt = null } = {}) {
  ctaLabel.textContent = label;
  cta.disabled = disabled; cta.classList.toggle("busy", busy);
  cta.setAttribute("aria-busy", String(busy));
  ctaAction = action;
  ctaAlt.hidden = !alt;
  // a "wide" alt is a shortcut the page itself also offers, so very narrow bars drop it rather than crowd the count
  ctaAlt.classList.toggle("wide-only", !!alt?.wide);
  if (alt) { ctaAlt.textContent = alt.label; ctaAltAction = alt.run; }
}
cta.addEventListener("click", () => ctaAction && ctaAction());
ctaAlt.addEventListener("click", () => ctaAltAction && ctaAltAction());
// the chip shrinks the number, never the symbol (which can carry an "unverified" flag)
function renderOutChip(num, sym, locked = false) {
  const chip = $("#outChip");
  chip.hidden = false;
  const o = state.building?.out || state.plan?.out || state.out, unv = unverifiedOut(o);
  // an unverified output keeps its flag in the chip as a warning mark, so the number still fits on a phone
  fill(chip, h("span", { class: "oc-num" }, h("span", { class: "oc-arr" }, "→ "), num ? `≈ ${num}` : ""),
    h("span", { class: "oc-sym" + (unv ? " warnt" : "") }, unv ? [o.symbol || short(o.id), icon("warn", "i oc-warn"), h("span", { class: "sr" }, " unverified")] : sym), icon("chev", "i"));
  chip.disabled = locked;
  const text = num ? `about ${num} ${sym}` : sym;
  chip.setAttribute("aria-label", locked ? `Swapping into ${text}` : `Swap into ${symOf(state.out)}. ${text}. Change output token`);
}
// the fee line: the full words on wider screens, a shorter tail on phones
const feeLine = (el, text, cls = "pinkt", tail = "", tailShort = "") => el.replaceChildren(h("span", { class: cls }, text, tail && h("span", { class: "m-hide" }, tail), tailShort && h("span", { class: "m-show" }, tailShort)));
const cooldownLeft = () => Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000));

function renderBar() {
  renderTop();
  const s = state.scene, chip = $("#outChip"), feeEl = $("#sumFee");
  $("#ring").hidden = true;
  chip.hidden = true; chip.classList.remove("stale"); feeEl.replaceChildren(); $("#sumWorth").textContent = "";
  if (s === "title") {
    caption("your wallet got dust. i got a duster");
    $("#sumCount").textContent = state.account ? "your dust is waiting" : "sell your dust";
    feeEl.replaceChildren(h("span", {}, "read-only until you approve"));
    return state.account ? setCta("back to your dust", { action: () => go("pockets") }) : setCta("connect wallet", { action: () => openWallets() });
  }
  if (root.classList.contains("cinema-on")) {
    caption("check the wallet. i’ll wait");
    $("#sumCount").textContent = plural(state.cinemaN || 0, "transaction");
    $("#sumWorth").textContent = "· 1 wallet prompt";
    feeEl.replaceChildren(h("span", {}, "nothing sent until you approve"));
    return setCta(innerWidth > 640 && (state.wallet?.name || "").length < 16 ? `waiting for ${state.wallet.name}…` : "waiting for wallet…", { disabled: true, busy: true });
  }

  if (s === "pockets") {
    const sel = selRows(), n = sel.length, total = totalUsd(), est = estOut();
    $("#sumCount").textContent = state.loading ? "reading balances…" : n ? plural(n, "token") : "nothing picked";
    $("#sumWorth").textContent = n ? `worth ≈ ${usd(total)}` : "";
    if (state.loading || state.loadError || !state.rows.length) {
      feeEl.replaceChildren(h("span", {}, state.loading ? "nothing gets signed" : state.loadError ? "nothing was signed or sent" : "nothing to sell here"));
    } else {
      renderOutChip(n && est != null ? outAmt(est, state.out) : null, symOf(state.out));
      if (n > MAX) feeEl.replaceChildren(h("span", { class: "warnt" }, icon("warn", "i i-sm"), `${n} / ${MAX} · max ${MAX} per run`));
      else if (n && feeOn()) feeLine(feeEl, `${pct(fee().bps)} fee ≈ ${usd(estFeeUsd())}`, "pinkt", " · bought & burned", " · burned");
      else if (n && isBurnOut()) feeLine(feeEl, "no fee", "greent");
      else if (n && state.feeErr) feeLine(feeEl, "any fee is shown in the review", "");
    }
    if (state.loading) { caption("turnin’ out every pocket"); return setCta("loading…", { disabled: true, busy: true }); }
    if (state.loadError) {
      $("#sumCount").textContent = "couldn’t load"; caption("the pockets wouldn’t open");
      const left = cooldownLeft();
      return left > 0 ? setCta(`try again in ${left}s`, { disabled: true }) : setCta("try again", { action: () => loadHoldings() });
    }
    if (!state.rows.length || !state.rows.some((r) => r.usd != null && !isBurnRow(r))) {
      $("#sumCount").textContent = "nothing to dust";
      // nothing to sell can still mean rent locked in empty accounts: offer that instead of a dead end
      const e = rcEmptiesMine();
      if (e.length) { caption("spotless. but there’s rent in the lining"); return setCta(`reclaim ${solApprox(e.reduce((a, x) => a + x.rentLamports, 0))} SOL`, { action: () => openCleanup() }); }
      caption("spotless. nothing to dust");
      return setCta("switch wallet", { action: () => openWallets() });
    }
    if (!n) { caption("pick what’s collectin’ dust"); return setCta("pick some dust", { disabled: true }); }
    if (n > MAX) { caption("that’s a lot of dust. one run at a time"); return setCta(`keep the ${MAX} largest`, { action: keepMax }); }
    if (unverifiedOut() && !state.customAck) { caption("check that address first"); return setCta("confirm the address first", { disabled: true }); }
    caption(isBurnOut() ? "straight to the source. no fee" : unverifiedOut() ? "double-check that address" : n >= 8 ? "found the dust in every corner" : "say less");
    return setCta(`preview ${plural(n, "swap")}`, { action: () => startPreview() });
  }

  if (s === "cleanup") return renderCleanupBar(feeEl);

  if (s === "cut") {
    const p = state.plan, b = state.building;
    if (b) {
      const lo = Math.min(b.done + 1, b.total), hi = Math.min(b.done + CHUNK, b.total);
      $("#sumCount").textContent = b.done >= b.total ? "checking…" : `routing ${lo === hi ? lo : `${lo}–${hi}`} of ${b.total}…`;
      renderOutChip(null, symOf(b.out), true);
      feeEl.replaceChildren(h("span", {}, "nothing gets signed yet"));
      caption("findin’ every token the cleanest exit");
      return setCta("building…", { disabled: true, busy: true, alt: { label: "cancel", run: cancelPreview } });
    }
    if (!p) return setCta("back to the pockets", { action: () => go("pockets", { back: true }) });
    const n = p.txs.length, t = planTotals(p);
    $("#sumCount").textContent = n ? plural(n, "transaction") : "nothing to send";
    $("#sumWorth").textContent = n ? "· 1 wallet prompt" : "";
    renderOutChip(n ? outAmt(t.receive, p.out) : null, symOf(p.out), true);
    chip.classList.toggle("stale", !!state.stale);
    if (p.feeApplied && n) feeLine(feeEl, `${p.feeBps ? pct(p.feeBps) + " fee" : "fee"} ≈ ${usd(t.feeUsd)}`, "pinkt", " · bought & burned", " · burned");
    else if (n && (fee() || p.feeApplied === false)) feeLine(feeEl, fee() ? "no fee" : "no fee on this run", "greent");
    if (state.busy === "signing") { caption("stampin’ a fresh blockhash…"); return setCta("preparing…", { disabled: true, busy: true }); }
    const left = cooldownLeft();
    if (!n && shortOfSol(p) && lamSum(rcEmptiesMine()) > 0) {
      // the rent in the wallet's empty accounts is the SOL these swaps are missing
      caption("short on SOL. your empty pockets got some");
      return setCta("get rent back", { action: () => openCleanup() });
    }
    if (!n) {
      caption(allRateLimited(p) ? "hold up. the server needs a breather" : shortOfSol(p) ? "short on SOL. top up a little" : "nothing made the cut");
      return setCta("back to the pockets", { action: () => go("pockets", { back: true }) });
    }
    $("#ring").hidden = false; renderRing(false);
    if (state.stale) {
      caption("quotes went stale. fresh ones needed");
      return left > 0 ? setCta(`refresh in ${left}s`, { disabled: true }) : setCta("refresh quotes", { action: () => refreshQuotes() });
    }
    caption(unverifiedOut(p.out) ? "double-check that address" : isBurnOut(p.out) ? "lookin’ clean. no fee on this one" : "lookin’ clean. your call");
    return setCta(`approve ${n} in wallet`, { action: approve });
  }

  if (s === "drop") {
    const r = state.run; if (!r) return setCta("dust again", { action: dustAgain });
    if (r.kind === "reclaim") return renderReclaimDropBar(r, feeEl);
    const c = r.items.filter((i) => i.status === "confirmed").length, n = r.items.length;
    $("#sumCount").textContent = `${c} of ${n} confirmed`;
    feeEl.replaceChildren(h("span", {}, r.done ? (r.sim ? "simulated run · nothing was sent" : "your token list is refreshing") : "keep this tab open until it’s done"));
    if (r.retrying) { caption("checkin’ what landed…"); return setCta("checking balances…", { disabled: true, busy: true }); }
    if (!r.done) { caption("sent. waitin’ on the network…"); return setCta(`sending ${n}…`, { disabled: true, busy: true }); }
    const failed = r.items.filter((i) => i.status !== "confirmed");
    if (!failed.length) { caption(rcEmptiesMine().length ? "clean sweep. rent’s still in the lining" : "clean sweep. not a speck left"); return setCta("dust again", { action: dustAgain }); }
    if (!c) { caption(failed.every((f) => f.status === "expired") ? "it expired before landing" : "nothing landed this time"); return setCta("preview again", { action: () => retryMints(failed) }); }
    caption("mostly clean");
    return setCta(failed.length === 1 ? "preview that one again" : `preview the ${failed.length} again`, { action: () => retryMints(failed), alt: { label: "done", run: dustAgain } });
  }
}

/* ================= holdings ================= */
const rowsEl = $("#rows"), rowEls = new Map();
let cdT;
// After a rate limit, every button that would call the server again waits out the timer and says how long.
// Buttons in the page opt in with data-cd (their label); they're patched in place so focus stays put.
function syncCooldownButtons() {
  const left = cooldownLeft();
  for (const b of $$("[data-cd]")) {
    b.disabled = left > 0 || !!state.busy;
    const label = b.querySelector(".cd-l") || b;
    label.textContent = left > 0 ? `${b.dataset.cd} in ${left}s` : b.dataset.cd;
  }
}
function startCooldown(sec) {
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + sec * 1000);
  clearInterval(cdT);
  const tick = () => {
    if ((state.scene === "pockets" && state.loadError) || ((state.scene === "cut" || state.scene === "cleanup") && !state.busy)) renderBar();
    syncCooldownButtons();
    if (Date.now() > state.cooldownUntil) clearInterval(cdT);
  };
  tick(); cdT = setInterval(tick, 1000);
}
async function loadHoldings({ silent = false } = {}) {
  if (!state.account) return;
  const ep = silent ? state.epoch : ++state.epoch;
  const addr = state.account.address;
  if (!silent) {
    state.loading = true; state.loadError = null; state.rows = []; state.nftCount = state.collectibleCount = state.uncheckedCount = 0; state.selected.clear(); state.plan = null;
    renderPockets();
    setPose(sceneMascot("pockets"), 12, { mode: "wiggle" });
    // the empty-pockets line and card read every account, empty ones too. RPC only (no prices, so no Jupiter
    // quota), and started alongside the holdings read so the line is usually ready before the list is
    loadAccounts({ silent: true });
  }
  let rows;
  try {
    rows = await api("/api/holdings?owner=" + encodeURIComponent(addr));
    if (!Array.isArray(rows)) throw new ApiError("Unexpected response from the server.", 500);
  } catch (e) {
    if (silent || ep !== state.epoch || state.account?.address !== addr) return; // a failed background refresh keeps the list we have
    state.loading = false;
    state.loadError = e.message;
    if (e.status === 429) startCooldown(30);
    setPose(sceneMascot("pockets"), 4);
    renderPockets();
    return;
  }
  if ((!silent && ep !== state.epoch) || state.account?.address !== addr) return;
  state.loading = false;
  state.rowsFor = addr;
  // NFTs and collectibles never become rows: not sold, not burned, not called tokens. Only how many there are is kept,
  // for one line. Ones the server couldn't check just now are left out too, and counted apart (not called NFTs).
  const alone = rows.filter((r) => r && r.nft === true && typeof r.mint === "string");
  const count = (f) => new Set(alone.filter(f).map((r) => r.mint)).size;
  state.uncheckedCount = count((r) => r.nftUnsure === true);
  state.nftCount = count((r) => r.nftUnsure !== true && isNftKind(r.nftKind));
  state.collectibleCount = count((r) => r.nftUnsure !== true && !isNftKind(r.nftKind));
  state.rows = rows.filter((r) => r && typeof r.mint === "string" && r.nft !== true).map((r) => ({
    mint: r.mint, amount: Number(r.amount) || 0, frozen: !!r.frozen,
    usd: typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : null,
    symbol: typeof r.symbol === "string" ? r.symbol.slice(0, 32) : null,
    name: typeof r.name === "string" ? r.name.slice(0, 64) : null,
    icon: typeof r.icon === "string" ? r.icon : null, verified: !!r.verified,
  })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  rcBackfillNames();
  if (silent) {
    // keep the selection, drop rows that are gone, no flashing
    state.selected = new Set([...state.selected].filter((m) => rowBy(m)));
    if (state.scene === "pockets") { syncRows(); renderPocketsMeta(); renderAside(); renderBar(); }
    return;
  }
  const capped = autoSelect(true);
  setPose(sceneMascot("pockets"), state.rows.some((r) => r.usd != null) ? 2 : 13);
  renderPockets({ stagger: true });
  if (capped) toast({ title: `picked the ${MAX} largest`, body: `You have ${capped} tokens in this range. ${MAX} fit in one run; dust the rest next run.` });
}
function autoSelect(first = false) {
  // the burn token is only ever ticked by hand, even after "let me sell it"
  let pick = state.rows.filter((r) => selectable(r) && inRange(r) && !isBurnRow(r));
  const total = pick.length;
  if (first && pick.length > MAX) pick = pick.slice(0, MAX); // already sorted by value, highest first
  state.selected = new Set(pick.map((r) => r.mint));
  return first && total > MAX ? total : 0;
}
function keepMax() {
  const keep = selRows().sort((a, b) => b.usd - a.usd).slice(0, MAX);
  const dropped = state.selected.size - keep.length;
  state.selected = new Set(keep.map((r) => r.mint));
  syncRows(); renderPocketsMeta(); renderAside(); renderBar();
  toast({ title: `kept the ${MAX} largest`, body: `${dropped} smaller ${dropped === 1 ? "one is" : "ones are"} unticked. Run them next time.` });
}

/* ---- presets ---- */
function buildPresets() {
  const seg = $("#presets");
  for (const p of PRESETS) {
    const b = h("button", { type: "button", "data-p": String(p), "aria-pressed": "false" }, p === "all" ? "all" : p === "custom" ? "custom…" : `≤ $${p}`);
    if (p === "custom") b.setAttribute("popovertarget", "rangePop");
    else b.addEventListener("click", () => setPreset(p));
    seg.append(b);
  }
}
function setPreset(p, range) {
  const prevSel = new Set(state.selected), prev = { preset: state.preset, range: state.range };
  state.preset = p;
  state.range = range || (p === "all" ? { min: 0, max: Infinity } : { min: 0, max: p });
  autoSelect();
  invalidatePlan();
  syncRows({ flip: true }); renderPocketsMeta(); renderAside(); renderBar(); movePresetThumb();
  if (state.rows.length) toast({
    title: `picked ${plural(state.selected.size, "token")} ${p === "all" ? "(every priced token)" : p === "custom" ? `between ${usd(state.range.min)} and ${state.range.max === Infinity ? "any value" : usd(state.range.max)}` : `under $${p}`}`,
    body: p === "all" ? "Includes your bigger holdings. Check the list before you preview." : "Your manual picks were reset.",
    actions: [{ label: "undo", run: () => { state.selected = prevSel; state.preset = prev.preset; state.range = prev.range; syncRows({ flip: true }); renderPocketsMeta(); renderAside(); renderBar(); movePresetThumb(); } }],
  });
  if (state.selected.size > 4) react(10, 2, 900);
}
function movePresetThumb() {
  const seg = $("#presets"), thumb = seg.querySelector(".seg-thumb");
  let active = null;
  for (const b of $$("button", seg)) { const on = String(state.preset) === b.dataset.p; b.setAttribute("aria-pressed", String(on)); if (on) active = b; }
  if (!active || !seg.offsetWidth) { thumb.style.opacity = "0"; return; }
  const first = thumb.style.opacity !== "1";
  if (first) thumb.style.transition = "none";
  thumb.style.opacity = "1";
  thumb.style.width = active.offsetWidth + "px";
  thumb.style.translate = active.offsetLeft + "px 0";
  if (first) { void thumb.offsetWidth; thumb.style.transition = ""; }
}
$("#rangeApply").addEventListener("click", () => {
  const min = Number($("#fMin").value) || 0, maxRaw = $("#fMax").value.trim(), max = maxRaw === "" ? Infinity : Number(maxRaw);
  const hint = $("#rangeHint");
  if (!(min >= 0) || !(max >= min)) { hint.textContent = "“At most” has to be at least as big as “at least”."; hint.classList.add("bad"); return; }
  hint.classList.remove("bad"); hint.textContent = "Picks every priced token in this range. You can still untick any of them.";
  closePop("rangePop");
  setPreset("custom", { min, max });
});

/* ---- token icons and rows (keyed, patched in place so focus and scroll survive) ---- */
// Token images only ever come from /api/img on this origin. The image a token's metadata points at is hosted
// wherever its creator chose (often a per-wallet airdrop), so loading it from here would tell them this visitor
// is on Spacedust right now; the server fetches it instead (SSRF-guarded), checks it's a real raster image and
// re-encodes it. The letter badge is the placeholder underneath and stays if there's no image. Names that look
// like lures never get a picture either: a scam's logo is part of the lure. The URL is /i/<mint> (rewritten to
// /api/img), so a list full of pictures never eats into the firewall's /api request budget. A failed image is
// tried once more after its error response has expired from the browser cache (cold IPFS content and busy gateways
// often answer on a later try); after that, the mint isn't asked for again for a few minutes.
const B58RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const badImg = new Map(); // mint -> when it failed for good
const IMG_RETRY_MS = 65_000; // just past the 60s browser max-age of a "try later" answer
function tokIcon(t, extra = "") {
  const label = (t.symbol || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?";
  const mint = t.mint || t.id;
  const isBurn = !!(t.burn || (burnId() && mint === burnId()));
  const el = h("span", { class: "tok-ico" + (isBurn ? " burn" : "") + (extra ? " " + extra : ""), "aria-hidden": "true" }, label);
  el.style.setProperty("--h", String(hash(mint || "x") % 360));
  if (typeof mint === "string" && B58RE.test(mint) && !(Date.now() - (badImg.get(mint) ?? -Infinity) < 180_000) && (isBurn || !looksSpam(t))) {
    const src = "/i/" + encodeURIComponent(mint);
    const img = h("img", { src, alt: "", loading: "lazy", decoding: "async", width: "36", height: "36" });
    let tries = 0;
    img.addEventListener("load", () => img.classList.add("on"));
    // the letter stays visible underneath while the image is missing (it only shows once it has loaded)
    img.addEventListener("error", () => {
      if (tries++ === 0) { setTimeout(() => { if (img.isConnected) { img.removeAttribute("src"); img.src = src; } }, IMG_RETRY_MS); return; }
      badImg.set(mint, Date.now()); img.remove();
    });
    el.append(img);
  }
  return el;
}
// names like "Claim 5,000 USDC at fr33-usdc.xyz" are lures even as plain text: keep them out of sight by default
const SPAMMY = /https?:|www\.|\.(xyz|com|io|net|org|app|site|top|fun|live|gg|me|co|vip|pro)\b|claim|airdrop|reward|visit|voucher|redeem|giveaway|\$\d|[<>]/i;
const looksSpam = (r) => !r.verified && SPAMMY.test(`${r.symbol || ""} ${r.name || ""}`);
const tokLabel = (r) => r?.symbol || short(r?.mint);
function makeRow(r) {
  const input = h("input", { type: "checkbox", class: "cb-input", "aria-label": `Sell ${tokLabel(r)}, worth ${usd(r.usd)}` });
  const flag = isBurnRow(r) ? h("span", { class: "flag pinkf" }, "burn token")
    : r.verified ? h("span", { class: "flag v", title: "Verified by Jupiter" }, icon("seal", "i"), h("span", { class: "sr" }, "verified"))
    : h("button", { class: "flag", type: "button", "aria-label": `${tokLabel(r)} is unverified. Details`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); $("#unvMint").textContent = r.mint; openPop("unvPop", e.currentTarget); } }, icon("warn", "i"), h("span", { class: "flag-t" }, "unverified"));
  const el = h("label", { class: "row", "data-mint": r.mint },
    h("span", { class: "sweep", "aria-hidden": "true" }, h("span", { class: "wipe" }), h("span", { class: "duster" })),
    h("span", { class: "tno" }),
    input, h("span", { class: "cb", "aria-hidden": "true" }, icon("spark"), h("i", { class: "dash" })),
    tokIcon(r),
    h("span", { class: "who" },
      h("span", { class: "who-top" }, h("span", { class: "sym" }, tokLabel(r)), r.frozen ? h("span", { class: "flag" }, "frozen") : flag),
      h("span", { class: "who-sub" }, r.frozen ? "Account frozen, can’t be sold" : [r.name ? h("span", { class: "nm" }, r.name + " · ") : "", h("span", { class: "mono" }, short(r.mint))])),
    h("span", { class: "worth" }, h("b", {}, usd(r.usd)), h("span", {}, amt(r.amount))));
  input.addEventListener("change", () => {
    if (state.busy) { input.checked = state.selected.has(r.mint); return; }
    if (input.checked) state.selected.add(r.mint); else state.selected.delete(r.mint);
    if (input.checked) sweep(el);
    invalidatePlan();
    renderPocketsMeta(); renderAside(); renderBar();
    if (input.checked) react(state.selected.size >= MAX ? 13 : 9, 2, 900);
    if (input.checked && r.usd > Math.max(25, state.range.max === Infinity ? 25 : state.range.max)) toast({ title: "heads up: that’s not dust", body: [h("span", { class: "data" }, tokLabel(r)), ` is worth ${usd(r.usd)}. Untick it if you meant to keep it.`] });
  });
  return el;
}
function sweep(row, delay = 0) {
  if (reduced()) return;
  const sw = row.querySelector(".sweep"), wipe = sw.querySelector(".wipe"), duster = sw.querySelector(".duster");
  const w = row.offsetWidth;
  const opt = { duration: 560, delay, easing: "cubic-bezier(.45,.05,.35,1)", fill: "both" };
  duster.animate([
    { opacity: 0, transform: "translateX(-40px) rotate(108deg)" },
    { opacity: 1, offset: 0.12 },
    { transform: `translateX(${w * 0.5}px) rotate(126deg)`, offset: 0.55 },
    { opacity: 1, offset: 0.85 },
    { opacity: 0, transform: `translateX(${w + 10}px) rotate(112deg)` },
  ], opt);
  wipe.animate([{ clipPath: "inset(0 100% 0 0)", opacity: 1 }, { clipPath: "inset(0 0% 0 0)", opacity: 1, offset: 0.8 }, { clipPath: "inset(0 0% 0 0)", opacity: 0 }], { ...opt, duration: 760 });
  for (let i = 0; i < 3; i++) {
    const g = icon("spark", "glint");
    g.style.left = 18 + Math.random() * 70 + "%"; g.style.top = 18 + Math.random() * 50 + "%";
    sw.append(g);
    g.animate([{ opacity: 0, transform: "scale(.2) rotate(0)" }, { opacity: 1, transform: "scale(1) rotate(45deg)", offset: 0.4 }, { opacity: 0, transform: "scale(.3) rotate(90deg)" }], { duration: 520, delay: delay + 240 + i * 90, easing: "ease-out", fill: "both" }).finished.then(() => g.remove(), () => g.remove());
  }
}
function syncRows({ flip = false, stagger = false } = {}) {
  const list = shown();
  // FLIP: remember where rows were, move them, then animate from the old spot
  const first = flip && !reduced() && list.length < 60 ? new Map([...rowsEl.children].map((el) => [el, el.getBoundingClientRect()])) : null;
  const keep = new Set(list.map((r) => r.mint));
  for (const [m, el] of rowEls) if (!keep.has(m)) { el.remove(); rowEls.delete(m); }
  rowsEl.querySelectorAll(".skel").forEach((e) => e.remove());
  list.forEach((r, i) => {
    let el = rowEls.get(r.mint);
    const isNew = !el;
    if (!el) { el = makeRow(r); rowEls.set(r.mint, el); }
    const input = el.querySelector("input");
    const ok = selectable(r);
    input.disabled = !ok || !!state.busy; input.checked = state.selected.has(r.mint);
    el.classList.toggle("off", !ok);
    el.querySelector(".tno").textContent = String(i + 1).padStart(2, "0");
    if (rowsEl.children[i] !== el) rowsEl.insertBefore(el, rowsEl.children[i] || null);
    if (isNew && stagger && !reduced() && i < 14) el.animate([{ opacity: 0, translate: "0 10px" }, { opacity: 1, translate: "0 0" }], { duration: 420, delay: 40 + i * 32, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
  });
  if (first) for (const el of rowsEl.children) {
    const f = first.get(el), l = el.getBoundingClientRect();
    if (!f) { el.animate([{ opacity: 0, scale: 0.98 }, { opacity: 1, scale: 1 }], { duration: 220, easing: "ease-out" }); continue; }
    const dy = f.top - l.top;
    if (dy) el.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], { duration: 380, easing: getComputedStyle(root).getPropertyValue("--spring").trim() || "ease-out" });
  }
}
// a small dusk still with Dusty large and centred, for the empty and error states
function stateStill(n, line, sub) {
  const [w, hh] = POSE_DIMS[n] || [254, 334];
  return h("div", { class: "state-still" },
    h("div", { class: "ss-sky", "aria-hidden": "true" }),
    h("img", { class: "ss-pose", src: pose(n), width: String(w), height: String(hh), alt: "", decoding: "async" }),
    h("p", { class: "ss-line" }, line),
    h("p", { class: "ss-sub" }, sub));
}
function renderPockets({ stagger = false } = {}) {
  const pkState = $("#pkState");
  const priced = state.rows.some((r) => r.usd != null && !isBurnRow(r));
  const empty = !state.loading && !state.loadError && !priced;
  $("#toolbar").hidden = !state.loading && (!!state.loadError || empty);
  $("#toolbar").inert = state.loading; $("#toolbar").classList.toggle("dim", state.loading);
  $("#tlHead").hidden = state.loading || !!state.loadError || empty;
  pkState.hidden = !(state.loadError || empty);
  if (state.loading) {
    for (const el of rowEls.values()) el.remove(); rowEls.clear();
    rowsEl.replaceChildren(...Array.from({ length: 6 }, (_, i) => h("div", { class: "row skel", "aria-hidden": "true" },
      h("span", {}), h("span", { class: "sk", style: "width:22px;height:22px;border-radius:7px" }), h("span", { class: "sk", style: "width:36px;height:36px;border-radius:50%" }),
      h("span", { style: "display:grid;gap:7px" }, h("span", { class: "sk", style: `width:${70 + ((i * 37) % 60)}px` }), h("span", { class: "sk", style: `width:${120 + ((i * 53) % 70)}px;height:9px` })),
      h("span", { style: "display:grid;gap:7px;justify-items:end" }, h("span", { class: "sk", style: "width:52px" }), h("span", { class: "sk", style: "width:34px;height:9px" })))));
    $("#pkFacts").textContent = "Reading balances and prices. Nothing gets signed.";
    $("#pk-title").textContent = "checkin’ the pockets…";
  } else if (state.loadError) {
    rowsEl.replaceChildren(); for (const el of rowEls.values()) el.remove(); rowEls.clear();
    $("#pk-title").textContent = "couldn’t read the pockets";
    $("#pkFacts").textContent = `${state.loadError} Nothing was signed or sent.`;
    fill(pkState, stateStill(4, "the pockets are stuck shut", "Give it a moment, then try again from the bar below."),
      h("div", { class: "state-actions" }, h("button", { class: "btn-ghost sm", type: "button", onclick: () => openWallets() }, icon("wallet", "i i-sm"), "switch wallet")));
  } else if (empty) {
    rowsEl.replaceChildren(); for (const el of rowEls.values()) el.remove(); rowEls.clear();
    $("#pk-title").textContent = "wallet’s spotless";
    const unpriced = state.rows.filter((r) => r.usd == null).length;
    $("#pkFacts").textContent = state.rows.length
      ? `Nothing here has a reliable price${unpriced ? ` (${plural(unpriced, "token")} without one, listed below)` : ""}, so there’s nothing Spacedust can sell safely.`
      : "No tokens besides SOL, so there’s nothing to dust.";
    // the left-alone line sits below the card (under the bar on a phone), so the facts say it first
    const alone = (state.nftCount || 0) + (state.collectibleCount || 0);
    if (alone) $("#pkFacts").textContent += ` ${leftAlonePhrase(state.nftCount || 0, state.collectibleCount || 0)} ${alone === 1 ? "is" : "are"} left alone.`;
    const rent = rcEmptiesMine();
    if (rent.length) $("#pkFacts").textContent += ` ${plural(rent.length, "empty account")} still ${rent.length === 1 ? "holds" : "hold"} about ${solAmt(rent.reduce((a, x) => a + x.rentLamports, 0))} SOL of rent you can get back.`;
    // with rent on offer, the bar's one action is "reclaim"; the card doesn't repeat it
    fill(pkState, rent.length ? stateStill(13, "no dust, just rent", "No dust to sell, but there’s rent in the lining. Reclaim it from the bar below.") : stateStill(13, "not a speck in sight", "Dusty checked every pocket. Come back when the airdrops pile up."),
      h("div", { class: "state-actions" },
        h("button", { class: "btn-ghost sm", type: "button", onclick: () => openWallets() }, icon("wallet", "i i-sm"), "switch wallet"),
        h("button", { class: "btn-text sm", type: "button", onclick: () => loadHoldings() }, icon("refresh", "i i-sm"), "check again")));
  } else {
    $("#pk-title").textContent = "pick your dust";
    syncRows({ stagger });
  }
  $(".pk-aside").hidden = !state.loading && (!!state.loadError || empty);
  renderRentCard();
  // one mascot per viewport: the set piece replaces the cameo in the empty and error states
  sceneMascot("pockets").hidden = !state.loading && (!!state.loadError || empty);
  renderPocketsMeta(); renderAside(); renderBar();
  requestAnimationFrame(movePresetThumb);
}
// "3 NFTs in this wallet are left alone": no rows, no selection, just so nobody wonders where they went. Collectibles
// (SFTs, game items, 0-decimal mints with no market price) are left alone the same way, and named for what they are.
const leftAlonePhrase = (nfts, coll) => [nfts > 0 && plural(nfts, "NFT"), coll > 0 && plural(coll, "collectible")].filter(Boolean).join(" and ");
const leftAloneThem = (nfts, coll) => (coll ? (nfts ? "NFTs or collectibles" : "collectibles") : "NFTs");
function uncheckedText(n) {
  return `${plural(n, "item")} couldn’t be checked just now, so ${n === 1 ? "it’s" : "they’re"} left out too.`;
}
function leftAloneLine(el, nfts, coll, unchecked) {
  el.hidden = !(nfts || coll || unchecked);
  if (el.hidden) return;
  const n = nfts + coll;
  fill(el, icon("info", "i i-sm"), h("span", {},
    n ? `${leftAlonePhrase(nfts, coll)} in this wallet ${n === 1 ? "is" : "are"} left alone. Spacedust never sells or burns ${leftAloneThem(nfts, coll)}.` : "",
    unchecked ? [n ? " " : "", uncheckedText(unchecked), " ", h("button", { class: "btn-text sm", type: "button", onclick: () => loadHoldings() }, "check again")] : ""));
}
function renderPocketsMeta() {
  if (state.loading) { $("#hiddenList").hidden = true; $("#keptLine").hidden = true; $("#nftLine").hidden = true; return; }
  if (state.loadError) leftAloneLine($("#nftLine"), 0, 0, 0);
  else leftAloneLine($("#nftLine"), state.nftCount || 0, state.collectibleCount || 0, state.uncheckedCount || 0);
  const list = shown(), selShown = list.filter((r) => state.selected.has(r.mint)).length, selectableShown = list.filter(selectable);
  const all = $("#selAll");
  all.checked = selectableShown.length > 0 && selShown === selectableShown.length;
  all.indeterminate = selShown > 0 && selShown < selectableShown.length;
  all.disabled = !selectableShown.length || !!state.busy;
  $("#selAllLabel").textContent = `select all shown (${selectableShown.length})`;
  const priced = state.rows.some((r) => r.usd != null && !isBurnRow(r));
  if (!state.loadError && priced) {
    const n = state.selected.size;
    const hiddenSel = selRows().filter((r) => !list.includes(r)).length;
    const parts = [`${plural(n, "token")} picked${n ? `, worth about ${usd(totalUsd())}` : ""}.`];
    if (hiddenSel) parts.push(`${hiddenSel} of them ${hiddenSel === 1 ? "is" : "are"} hidden by your filter.`);
    if (!list.length) parts.push(state.query ? "No tokens match that search." : "No tokens in this range. Try a bigger one.");
    if (n > MAX) parts.push(`Up to ${MAX} per run.`);
    $("#pkFacts").textContent = parts.join(" ");
  }
  // unpriced: visible, inspectable, never selectable
  const unpriced = state.loadError ? [] : state.rows.filter((r) => r.usd == null);
  const hl = $("#hiddenList");
  hl.hidden = !unpriced.length;
  if (unpriced.length) {
    $("#hiddenSummary").textContent = `${plural(unpriced.length, "token")} hidden: no reliable price, so ${unpriced.length === 1 ? "it can’t" : "they can’t"} be swapped safely`;
    $("#hiddenRows").replaceChildren(...unpriced.map((r) => {
      const spam = looksSpam(r);
      const nameEl = h("div", { style: "min-width:0" },
        h("span", { class: "sym" }, spam ? "name hidden: likely spam" : tokLabel(r)),
        h("span", { class: "who-sub" }, spam ? h("span", { class: "mono" }, short(r.mint)) : r.symbol ? [r.name ? r.name.slice(0, 40) + (r.name.length > 40 ? "…" : "") + " · " : "", h("span", { class: "mono" }, short(r.mint))] : "no name or symbol"));
      if (spam) nameEl.append(h("button", { class: "btn-text sm reveal", type: "button", onclick: (e) => {
        const box = e.currentTarget.parentElement;
        box.replaceChildren(h("span", { class: "sym" }, tokLabel(r)), h("span", { class: "who-sub" }, r.name ? r.name + " · " : "", h("span", { class: "mono" }, short(r.mint))));
        box.tabIndex = -1; box.focus({ preventScroll: true });
      } }, "show name"));
      return h("div", { class: "hrow" }, nameEl, h("span", { class: "who-sub" }, amt(r.amount)));
    }));
  }
  // the burn token stays out of the list unless the user explicitly asks for it
  const burnRow = state.rows.find(isBurnRow);
  const kept = $("#keptLine");
  const showKept = !!burnRow && feeOn() && burnRow.usd != null && !state.loadError;
  kept.hidden = !showKept;
  if (showKept) {
    fill(kept, tokIcon(burnRow),
      h("p", { class: "kept-txt" },
        h("b", {}, state.includeBurn ? `your ${burnSym()} is in the list` : `kept: your ${burnSym()} (${amt(burnRow.amount)} · ${usd(burnRow.usd)})`),
        h("span", {}, state.includeBurn ? "It’s selectable now. Selling it while every swap buys and burns it mostly cancels out." : "Spacedust never picks the burn token for you. Selling it while every swap buys and burns it mostly cancels out.")),
      h("button", { class: "btn-ghost sm", type: "button", disabled: !!state.busy, onclick: () => {
        state.includeBurn = !state.includeBurn;
        if (!state.includeBurn) state.selected.delete(burnRow.mint);
        invalidatePlan(); syncRows({ flip: true }); renderPocketsMeta(); renderAside(); renderBar();
      } }, state.includeBurn ? "hide it again" : "let me sell it"));
  }
}
$("#selAll").addEventListener("change", (e) => {
  if (state.busy) return;
  const list = shown().filter(selectable);
  if (e.target.checked) list.forEach((r) => state.selected.add(r.mint)); else list.forEach((r) => state.selected.delete(r.mint));
  invalidatePlan();
  if (e.target.checked) [...rowsEl.children].slice(0, 12).forEach((el, i) => sweep(el, i * 28));
  syncRows(); renderPocketsMeta(); renderAside(); renderBar();
  if (e.target.checked) react(10, 2, 1000);
});
$("#selClear").addEventListener("click", () => { if (state.busy) return; state.selected.clear(); invalidatePlan(); syncRows(); renderPocketsMeta(); renderAside(); renderBar(); });
let qT;
$("#listSearch").addEventListener("input", (e) => { clearTimeout(qT); qT = setTimeout(() => { state.query = e.target.value; syncRows({ flip: true }); renderPocketsMeta(); }, 120); });

/* ---- aside: output, burn, protection ---- */
function optEst(o) {
  const n = state.selected.size;
  if (!n) return isBurnOut(o) ? "no fee" : o.name;
  const e = estOut(o);
  return e == null ? o.name : `≈ ${outAmt(e, o)}`;
}
function renderAside() {
  const grid = $("#intoGrid");
  const list = outs();
  grid.classList.toggle("three", list.length === 3);
  grid.replaceChildren(...list.map((o) => h("button", {
    class: "opt", type: "button", role: "radio", "aria-checked": String(state.out.id === o.id), tabindex: state.out.id === o.id || (isCustomOut() && o === list[0]) ? "0" : "-1",
    "aria-label": `${symOf(o)}${isBurnOut(o) ? ", no fee" : ""}`, disabled: !!state.busy, onclick: () => setOut(o),
  }, tokIcon(o), h("span", { class: "opt-sym" }, symOf(o)), h("span", { class: "opt-est" }, optEst(o)), isBurnOut(o) && h("span", { class: "nofee" }, "no fee"))));
  grid.onkeydown = (e) => {
    const bs = $$(".opt", grid), i = bs.indexOf(document.activeElement);
    if (i < 0 || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault(); const j = (i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length; bs[j].focus(); bs[j].click();
  };
  $("#otherBtn").disabled = !!state.busy; $("#setBtn").disabled = !!state.busy;
  const cust = $("#intoCustom");
  cust.hidden = !isCustomOut();
  if (isCustomOut()) {
    const o = state.out;
    if (o.verified) fill(cust, h("div", { class: "opt", "aria-checked": "true", role: "radio", style: "width:100%" }, tokIcon(o), h("span", { class: "opt-sym" }, o.symbol || short(o.id)), h("span", { class: "opt-est mono" }, short(o.id))));
    else {
      const ack = h("input", { type: "checkbox" }); ack.checked = state.customAck;
      ack.addEventListener("change", () => { state.customAck = ack.checked; renderBar(); });
      fill(cust, h("div", { class: "warn-card", role: "group", "aria-label": "Unverified output token" },
        h("p", { class: "warn-title" }, icon("warn"), "warning: unverified output"),
        h("p", {}, "You picked ", h("span", { class: "data" }, o.symbol || "a token"), o.name ? [" (", h("span", { class: "data" }, o.name), ")"] : "", ". It’s not on Jupiter’s verified list, and names can be copied. Check the full address:"),
        h("span", { class: "mono mint-full" }, o.id),
        h("label", { class: "toggle sm" }, ack, h("span", { class: "tg", "aria-hidden": "true" }), h("span", {}, "I checked this address"))));
    }
  }
  // burn card
  const bc = $("#burnCard");
  bc.hidden = !fee() && !state.feeErr;
  bc.classList.toggle("nofee-state", isBurnOut());
  bc.classList.toggle("err-state", state.feeErr);
  if (state.feeErr) {
    fill(bc, h("p", { class: "overline" }, "the fee"), h("p", { class: "hint", style: "color:var(--lav-2)" }, "Couldn’t load fee settings. Any fee is still shown in the review before you sign."));
  } else if (fee()) {
    if (isBurnOut()) fill(bc, h("p", { class: "overline green" }, "the burn"), h("p", { class: "burn-head" }, `no fee: you’re swapping into ${burnSym()}`), h("p", { class: "hint" }, "Nothing extra is bought or burned. You keep 100% of the route’s output."));
    else {
      const f = estFeeUsd(), bp = state.prices[burnId()], burned = bp ? f / bp : null;
      fill(bc,
        h("p", { class: "overline pink" }, "the burn"),
        h("p", { class: "burn-head" }, `${pct(fee().bps)} fee, bought and burned`),
        h("p", { class: "burn-est" }, state.selected.size ? [h("b", {}, `≈ ${usd(f)}`), burned != null && [icon("arrow", "i"), h("span", {}, `≈ ${int(burned)} ${burnSym()} burned`)]] : h("span", {}, "Pick tokens to see the estimate.")),
        h("p", { class: "hint" }, "Bought and burned inside each swap’s own transaction. Nobody receives it. If a swap fails, no fee is taken."),
        h("button", { class: "btn-text sm", type: "button", popovertarget: "burnPop", style: "margin-left:-4px" }, icon("info", "i i-sm"), "where does it go?"));
    }
  }
  renderSetSummary();
}
function setOut(o) {
  if (state.busy || state.out.id === o.id) return;
  state.out = o; state.customAck = false;
  state.selected.delete(o.id);
  if (!isCustomOut()) store.set("out", o.id);
  invalidatePlan();
  syncRows({ flip: true }); renderPocketsMeta(); renderAside(); renderBar();
  if (isBurnOut(o)) react(5, 2, 1300);
}
function renderSetSummary() {
  const s = state.set;
  $("#setSum").textContent = `${s.slip}% max slippage · skip if > ${s.loss}% loss · ${s.close ? "close emptied accounts" : "keep emptied accounts"}`;
}
function renderBurnPop() {
  const f = fee(); if (!f) return;
  $("#bp-title").textContent = `where the ${pct(f.bps)} goes`;
  $("#bpStep2").textContent = `${pct(f.bps)} of the minimum guaranteed output buys ${burnSym()}.`;
  $("#bpMintLabel").textContent = `${burnSym()} mint · copycats share the name`;
  $("#popMint").textContent = f.burnToken.id;
  $("#skipFeeBtn").textContent = `swap into ${burnSym()} instead · no fee`;
}
$("#skipFeeBtn").addEventListener("click", () => { closePop("burnPop"); if (!fee()) return; setOut(burnOut()); toast({ title: `swapping into ${burnSym()}`, body: "No fee on this run. Nothing extra is bought or burned." }); });

/* ---- output popover + combobox search ---- */
function renderOutPop() {
  // every row shows its estimate, so outputs can be compared; the check and NO FEE marks sit next to it
  $("#outList").replaceChildren(...outs().map((o) => {
    const e = state.selected.size ? estOut(o) : null;
    return h("button", { class: "out-item", type: "button", "aria-current": state.out.id === o.id ? "true" : false, onclick: () => { setOut(o); closePop("outPop"); } },
      tokIcon(o), h("span", { style: "min-width:0" }, h("b", {}, symOf(o)), h("br"), h("span", { class: "r" }, o.name)),
      h("span", { class: "oi-end" },
        e != null && h("span", { class: "r" }, `≈ ${outAmt(e, o)}`),
        isBurnOut(o) && h("span", { class: "nofee-inline" }, "no fee"),
        state.out.id === o.id && [icon("check", "i chk"), h("span", { class: "sr" }, "selected")]));
  }));
  const input = $("#outSearch");
  input.value = ""; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  $("#outResults").hidden = true; $("#outResults").replaceChildren();
  $("#outNote").textContent = "Type 2+ letters. Results show verified status and the address, because names can be copied.";
}
let searchSeq = 0, searchT, activeIdx = -1;
$("#outSearch").addEventListener("input", (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim(), list = $("#outResults"), note = $("#outNote");
  if (q.length < 2) { searchSeq++; list.hidden = true; e.target.setAttribute("aria-expanded", "false"); note.textContent = "Type 2+ letters. Results show verified status and the address, because names can be copied."; return; }
  note.textContent = "searching…";
  searchT = setTimeout(async () => {
    const seq = ++searchSeq;
    let res;
    try { res = await api("/api/tokens/search?q=" + encodeURIComponent(q.slice(0, 64))); }
    catch (err) { if (seq === searchSeq) { list.hidden = true; note.textContent = err.message; } return; }
    if (seq !== searchSeq) return; // a newer search is in flight
    res = (Array.isArray(res) ? res : []).filter((t) => t && typeof t.id === "string");
    activeIdx = -1;
    list.replaceChildren(...res.map((t, i) => {
      const priced = typeof t.usdPrice === "number" && t.usdPrice > 0;
      const li = h("li", { role: "option", id: "opt-" + i, "aria-selected": "false", "aria-disabled": priced ? false : "true" },
        tokIcon(t), h("span", { class: "cm-main" }, h("b", {}, t.symbol || "?"), " ", h("span", { class: "cm-sub" }, t.name || ""), h("span", { class: "cm-sub mono", style: "display:block" }, short(t.id))),
        !priced ? h("span", { class: "flag" }, "no price") : t.verified ? h("span", { class: "flag v" }, icon("seal", "i"), "verified") : h("span", { class: "flag warn" }, icon("warn", "i"), "unverified"));
      li.addEventListener("click", () => {
        if (!priced) { note.textContent = "That token has no reliable price, so swaps into it can’t be checked. Pick another."; return; }
        pickCustom(t);
      });
      return li;
    }));
    list.hidden = !res.length; e.target.setAttribute("aria-expanded", String(!!res.length));
    note.textContent = res.length ? `${plural(res.length, "result")}. Use the arrow keys, Enter to pick.` : "No tokens found.";
  }, 300);
});
$("#outSearch").addEventListener("keydown", (e) => {
  const items = $$("#outResults li"); if (!items.length || $("#outResults").hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.setAttribute("aria-selected", String(i === activeIdx)));
    e.target.setAttribute("aria-activedescendant", items[activeIdx].id); items[activeIdx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); items[activeIdx].click(); }
});
function pickCustom(t) {
  closePop("outPop");
  const known = outs().find((o) => o.id === t.id);
  if (known) return setOut(known);
  setOut({ id: t.id, symbol: typeof t.symbol === "string" ? t.symbol.slice(0, 32) : null, name: typeof t.name === "string" ? t.name.slice(0, 64) : "", icon: t.icon, verified: !!t.verified, usdPrice: t.usdPrice });
  if (!t.verified) requestAnimationFrame(() => $("#intoCustom").scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" }));
}

/* ---- settings ---- */
function syncSettingsForm() {
  $("#fSlip").value = state.set.slip; $("#fLoss").value = state.set.loss; $("#fClose").checked = state.set.close;
  $$("#slipChips button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === state.set.slip)));
  validateSettings();
}
function validateSettings() {
  const slip = Number($("#fSlip").value), loss = Number($("#fLoss").value);
  const slipOk = $("#fSlip").value !== "" && slip >= 0.1 && slip <= 20, lossOk = $("#fLoss").value !== "" && loss >= 0 && loss <= 50;
  $("#fSlip").parentElement.classList.toggle("bad", !slipOk); $("#fLoss").parentElement.classList.toggle("bad", !lossOk);
  $("#slipHint").textContent = slipOk ? "A swap fails instead of filling worse than this." : `Use 0.1% to 20%. Leaving it like this keeps ${state.set.slip}%.`;
  $("#slipHint").classList.toggle("bad", !slipOk);
  $("#lossHint").textContent = lossOk ? "Compared with the market price. Dust often has thin markets. Max 50%." : `Use 0% to 50%. Leaving it like this keeps ${state.set.loss}%.`;
  $("#lossHint").classList.toggle("bad", !lossOk);
  return { slipOk, lossOk, slip, loss };
}
// Settings never change while a preview builds or the wallet signs: the plan on screen must be the one signed.
// A loss limit raised from a skipped token's fix button is for this session only (state.tempLoss holds the
// saved value), so one tap can't make every later run riskier.
function applySettings(next, { persist = true, quiet = false } = {}) {
  if (state.busy) return false;
  const changed = JSON.stringify(next) !== JSON.stringify(state.set);
  if (persist && state.tempLoss && next.loss !== state.set.loss) state.tempLoss = null; // the user set it by hand
  state.set = next;
  if (persist) store.set("set", state.tempLoss ? { ...next, loss: state.tempLoss.from } : next);
  $$("#slipChips button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === state.set.slip)));
  renderSetSummary();
  if (!changed) return true;
  if (state.plan && state.scene === "cut" && !state.plan.sent) { state.stale = true; state.staleWhy = "settings"; stopRing(); renderCut(); renderBar(); if (!quiet) toast({ title: "settings changed, preview again", body: "The quotes on screen used the old settings." }); }
  else invalidatePlan();
  return true;
}
function commitSettings() {
  if (state.busy) return;
  const { slipOk, lossOk, slip, loss } = validateSettings();
  applySettings({ slip: slipOk ? slip : state.set.slip, loss: lossOk ? loss : state.set.loss, close: $("#fClose").checked });
}
["#fSlip", "#fLoss"].forEach((s) => { $(s).addEventListener("input", validateSettings); $(s).addEventListener("change", commitSettings); });
$("#fClose").addEventListener("change", commitSettings);
$$("#slipChips button").forEach((b) => b.addEventListener("click", () => { $("#fSlip").value = b.dataset.v; commitSettings(); }));
$("#setReset").addEventListener("click", () => { state.tempLoss = null; applySettings({ ...DEFAULT_SET }, { quiet: true }); syncSettingsForm(); });
let setAtOpen = null;
$("#setPop").addEventListener("toggle", (e) => {
  if (e.newState === "open") { setAtOpen = JSON.stringify(state.set); return; }
  const v = validateSettings(); if (!v.slipOk) $("#fSlip").value = state.set.slip; if (!v.lossOk) $("#fLoss").value = state.set.loss;
  commitSettings();
  // a quiet confirmation that the sheet saved (the review has its own "preview again" note)
  if (setAtOpen && setAtOpen !== JSON.stringify(state.set) && state.scene !== "cut")
    toast({ title: "protection saved", body: `${state.set.slip}% max slippage, skip above ${state.set.loss}% loss, ${state.set.close ? "close" : "keep"} emptied accounts.`, tone: "ok", timeout: 3200 });
  setAtOpen = null;
});

function invalidatePlan() { if ((state.plan && !state.plan.sent) || state.stale) { state.plan = null; state.stale = false; state.staleWhy = null; stopRing(); } }

/* ================= SC. 02 · preview, built in chunks ================= */
function txInfo(t, p) {
  const legs = t.legs || [];
  const first = rowBy(legs[0]?.mint) || { mint: legs[0]?.mint };
  const outAmount = legs.reduce((a, l) => a + (Number(l.outAmount) || 0), 0);
  const minOut = legs.every((l) => typeof l.minOut === "number") ? legs.reduce((a, l) => a + l.minOut, 0) : null;
  const usdIn = legs.reduce((a, l) => a + (Number(l.usdIn) || 0), 0);
  const feeAmt = t.fee?.amountIn || 0;
  return {
    mints: legs.map((l) => l.mint), mint: first.mint, symbol: legs.length > 1 ? legs.map((l) => tokLabel(rowBy(l.mint) || { mint: l.mint })).join(" + ") : tokLabel(first),
    icon: first.icon, verified: first.verified, amount: first.amount, usdIn, outAmount, minOut, fee: t.fee || null,
    receive: outAmount - feeAmt, minReceive: minOut == null ? null : Math.max(0, minOut - feeAmt),
    loss: p.outPrice && usdIn > 0 ? 1 - (outAmount * p.outPrice) / usdIn : null,
  };
}
function planTotals(p) {
  const items = p.txs.map((t) => txInfo(t, p));
  const sum = (f) => items.reduce((a, t) => a + (f(t) || 0), 0);
  return {
    items, usdIn: sum((t) => t.usdIn), receive: sum((t) => t.receive),
    minReceive: items.every((t) => t.minReceive != null) ? sum((t) => t.minReceive) : null,
    feeAmt: sum((t) => t.fee?.amountIn), feeUsd: sum((t) => t.fee?.usd), burned: sum((t) => t.fee?.burned),
  };
}
// Builds the preview in chunks of CHUNK tokens, one /api/plan request after another, so rows fill in as each
// chunk returns. `reuse` keeps transactions from the plan on screen whose quotes are still young (a time-only
// refresh), so only the stale ones are quoted again. Every transaction remembers when its chunk was quoted, and
// the freshness ring counts from the OLDEST quote, not the last one.
async function startPreview(mints, { notice = null, reuse = null } = {}) {
  if (state.busy || !state.account) return;
  const order = new Map(state.rows.map((r, i) => [r.mint, i]));
  let list = (Array.isArray(mints) ? mints : selRows().map((r) => r.mint)).filter((m) => { const r = rowBy(m); return r && selectable(r); });
  list = [...new Set(list)].sort((a, b) => order.get(a) - order.get(b)).slice(0, MAX);
  if (!list.length) { toast({ title: "nothing to preview", body: "None of those tokens can be sold from this wallet right now." }); return go("pockets", { back: true }); }
  closeAllPops(); clearToasts();
  const ep = ++state.epoch;
  const ctrl = new AbortController();
  const out = state.out, set = { ...state.set }, owner = state.account.address;
  const kept = (reuse?.txs || []).filter((t) => (t.legs || []).every((l) => list.includes(l.mint)));
  const keptMints = new Set(kept.flatMap((t) => t.legs.map((l) => l.mint)));
  state.plan = null; state.stale = false; state.staleWhy = null; state.notice = notice;
  state.busy = "building";
  state.building = { total: list.length, done: keptMints.size, items: list.map((m) => ({ mint: m, st: keptMints.has(m) ? "ready" : "queued" })), ctrl, out };
  stopRing();
  if (state.scene !== "cut") await go("cut"); else renderBar();
  if (ep !== state.epoch) return;
  setPose(sceneMascot("cut"), 12, { mode: "wiggle" });
  renderCut(); renderBar();
  const merged = { txs: [...kept], skipped: [], feeApplied: kept.length ? !!reuse.feeApplied : null, burnMint: kept.length ? reuse.burnMint : null, outPrice: kept.length ? reuse.outPrice : null };
  let failure = null;
  const todo = state.building.items.filter((it) => it.st === "queued");
  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  // Chunks share one Jupiter rate limit (per account), so they only run side by side when the plan has room; on a
  // plan with plenty (Developer and up) a full preview's chunks all go at once.
  const lanes = Math.max(1, Math.min(Math.ceil(MAX / CHUNK), Math.floor((state.jupRps || 1) / 3)));
  let next = 0;
  const runChunk = async (chunk) => {
    chunk.forEach((it) => (it.st = "routing"));
    renderCut(); renderBar();
    const at = Date.now();
    const res = await api("/api/plan", {
      owner, outMint: out.id, mints: chunk.map((c) => c.mint),
      slippageBps: Math.round(set.slip * 100), maxLossPct: set.loss, closeAccounts: set.close,
    }, { signal: ctrl.signal });
    if (ep !== state.epoch) return;
    merged.txs.push(...(res.txs || []).map((t) => ({ ...t, at })));
    merged.skipped.push(...(res.skipped || []));
    merged.feeApplied = merged.feeApplied || !!res.feeApplied;
    merged.burnMint = res.burnMint || merged.burnMint;
    if (typeof res.outPrice === "number") merged.outPrice = res.outPrice;
    if (typeof res.solLamports === "number") merged.solLamports = res.solLamports;
    const ready = new Set((res.txs || []).flatMap((t) => (t.legs || []).map((l) => l.mint)));
    const skipped = new Map((res.skipped || []).map((s) => [s.mint, s.reason]));
    for (const it of chunk) {
      if (ready.has(it.mint)) it.st = "ready";
      else { it.st = "skipped"; if (!skipped.has(it.mint)) merged.skipped.push({ mint: it.mint, reason: "not included by the server" }); }
    }
    state.building.done = Math.min(list.length, state.building.items.filter((it) => it.st === "ready" || it.st === "skipped").length);
    renderCut(); renderBar();
  };
  await Promise.all(Array.from({ length: Math.min(lanes, chunks.length) }, async () => {
    while (!failure && next < chunks.length && ep === state.epoch) {
      const chunk = chunks[next++];
      try { await runChunk(chunk); }
      catch (e) {
        if (e.name === "AbortError" || ep !== state.epoch) return;
        failure = failure || e;
        if (e.status === 429) startCooldown(60);
      }
    }
  }));
  if (ep !== state.epoch) return;
  if (failure) {
    // everything not routed yet is listed as skipped with the reason, so a retry can pick it up
    for (const it of todo) if (it.st === "queued" || it.st === "routing") {
      it.st = "skipped"; merged.skipped.push({ mint: it.mint, reason: failure.status === 429 ? "rate limited" : "preview failed: " + failure.message });
    }
  }
  if (ep !== state.epoch) return;
  const pos = new Map(list.map((m, i) => [m, i]));
  merged.txs.sort((a, b) => (pos.get(a.legs?.[0]?.mint) ?? 0) - (pos.get(b.legs?.[0]?.mint) ?? 0));
  state.plan = { ...merged, out, set, owner, mints: list, sent: false, feeBps: merged.feeApplied ? fee()?.bps ?? null : null };
  state.planAt = merged.txs.length ? Math.min(...merged.txs.map((t) => t.at || Date.now())) : Date.now();
  state.building = null; setIdle();
  renderCut(); renderBar(); startRing();
  const n = state.plan.txs.length;
  setPose(sceneMascot("cut"), n ? 19 : 4);
  srSay(n ? `Preview ready: ${plural(n, "transaction")}, one wallet prompt.${merged.skipped.length ? ` ${merged.skipped.length} skipped.` : ""}` : "Nothing could be swapped. Reasons are listed.");
  if (failure) {
    const p = state.plan;
    const retry = retryableMints(p);
    toast({ title: n ? "the preview stopped early" : "couldn’t build the preview", body: `${failure.message} ${n ? "Tokens that weren’t quoted are listed as skipped." : ""} Nothing was signed or sent.`, tone: "bad",
      actions: failure.status === 429 || !retry.length ? [] : [{ label: n ? "preview again, with the rest" : "try again", run: () => startPreview(n ? [...readyMints(p), ...retry] : list, { reuse: n ? youngTxs(p) : null }) }] });
  }
}
const readyMints = (p) => p.txs.flatMap((t) => (t.legs || []).map((l) => l.mint));
const retryableMints = (p) => p.skipped.filter((s) => humanSkip(s, p).fix === "retry").map((s) => s.mint);
// quotes young enough to keep through a re-quote: at least half their signing window left
const youngTxs = (p) => ({ txs: p.txs.filter((t) => t.at && Date.now() - t.at < TTL_MS / 2), feeApplied: p.feeApplied, burnMint: p.burnMint, outPrice: p.outPrice });
const allRateLimited = (p) => !!p && !p.txs.length && p.skipped.length > 0 && p.skipped.every((s) => s.reason === "rate limited");
// "refresh quotes": when only time went by, keep the young quotes and re-quote the rest; when settings,
// the output or the account changed, everything is quoted again
function refreshQuotes({ notice = null } = {}) {
  const p = state.plan; if (!p) return;
  const same = state.staleWhy !== "settings" && JSON.stringify(p.set) === JSON.stringify(state.set) && p.out.id === state.out.id && p.owner === state.account?.address;
  return startPreview(p.mints, { notice, reuse: same ? youngTxs(p) : null });
}
function cancelPreview() {
  state.building?.ctrl?.abort();
  state.epoch++; state.building = null; state.plan = null; setIdle();
  go("pockets", { back: true }).then(() => { syncRows(); renderPocketsMeta(); renderAside(); renderBar(); });
  toast({ title: "preview cancelled", body: "Nothing was signed or sent." });
}
$("#cutBack").addEventListener("click", () => {
  if (state.busy === "building") return cancelPreview();
  if (state.busy) return;
  stopRing(); invalidatePlan();
  go("pockets", { back: true }).then(() => { syncRows(); renderPocketsMeta(); renderAside(); renderBar(); });
});

// a swap the wallet can't fund: rent for an account the swap opens (wrapped SOL, which the same transaction closes
// again, or a first-time token account) plus the network fee
const NO_SOL = "not enough SOL";
const lowSolWhy = (p) => "Not enough SOL on hand. While a swap runs, it needs about 0.002 SOL of rent for each token account it opens (a temporary one comes back in the same transaction) plus a network fee."
  + (typeof p.solLamports === "number" ? ` This wallet has ${solAmt(p.solLamports)} SOL.` : "");
// nothing could be built and at least one swap was short of SOL: that's the fix to lead with
const shortOfSol = (p) => !!p && !p.txs.length && p.skipped.some((s) => s.reason === NO_SOL);
// the way out of "not enough SOL": rent the cleanup can give back, or else adding a little SOL
function lowSolFix(busy) {
  const lam = lamSum(rcEmptiesMine());
  if (rcMine() && state.rc.accounts && !lam) return h("p", { class: "hint" }, "Add a little SOL to this wallet (0.003 SOL covers it), then try again.");
  return h("div", { class: "skip-fix" }, h("button", { class: "btn-ghost sm", type: "button", "data-fk": "fix-rent", disabled: busy, onclick: () => openCleanup() },
    lam ? `get ${solApprox(lam)} SOL of rent back first` : "look for rent to get back first", icon("arrow", "i i-sm")));
}
function humanSkip(s, p) {
  const r = String(s.reason || "");
  let m;
  if (r === "rate limited") return { why: "Not quoted yet: Spacedust is busy right now. Nothing was built or signed.", fix: "retry" };
  if (r.startsWith("quote service busy")) return { why: "Jupiter’s quote service is busy right now. Try again in a moment.", fix: "retry" };
  if (r.startsWith("no route")) return { why: "No market for this token right now.", fix: "retry" };
  if ((m = r.match(/route returns \$([\d.]+) for \$([\d.]+)/))) {
    const got = +m[1], inn = +m[2], loss = inn > 0 ? Math.max(0, (1 - got / inn) * 100) : 100;
    const need = Math.ceil(loss + 1);
    return { why: `Would return ${usdP(got)} for ${usdP(inn)} (−${loss.toFixed(0)}% vs. market). Your limit is ${p.set.loss}%.`, loss: need <= 50 ? need : null,
      note: need > 50 ? "That’s more than the 50% maximum, so it can’t be included." : null };
  }
  if (r === NO_SOL) return { why: lowSolWhy(p), fix: "retry", cleanup: true };
  if (r.startsWith("buy-and-burn")) return { why: "The burn route is busy right now, and a swap never goes through without its fee. Try again in a moment.", fix: "retry" };
  if (r.startsWith("route too large")) return p.out.id === SOL
    ? { why: "This token’s route is too complex to fit in one transaction with its burn, so it can’t be sold here right now." }
    : { why: "The route is too complex to fit in one transaction with its burn. Swapping into SOL usually leaves more room.", fix: "sol" };
  if (r.startsWith("simulation failed")) return { why: "This token can’t be sold right now: its swap failed in simulation, so it was skipped. Nothing was sent.", raw: r };
  if (r === "account frozen") return { why: "This token account is frozen by its issuer, so it can’t be moved." };
  if (r === "no reliable price") return { why: "No reliable price right now, so the swap can’t be checked against the market." };
  if (r === "not in wallet") return { why: "It’s no longer in this wallet." };
  if (r === "NFTs aren't sold here") return { why: "It’s an NFT, and Spacedust never sells NFTs." };
  if (r === "collectibles aren't sold here") return { why: "It’s a collectible with no market price, and Spacedust never sells those." };
  if (r.startsWith("couldn't check whether it's an NFT")) return { why: "Couldn’t confirm it isn’t an NFT just now, so it was left out. Nothing was built or signed.", fix: "retry" };
  if (r.startsWith("preview failed: ")) return { why: `Not quoted. ${r.slice(16)}`, fix: "retry" };
  return { why: r.charAt(0).toUpperCase() + r.slice(1) + (/[.]$/.test(r) ? "" : ".") };
}
function txRow(t, i, extra = {}) {
  const o = extra.out || state.plan?.out || state.out;
  const hv = t.usdIn > 25;
  const key = t.mint || String(i);
  return h("li", { class: "tx" + (extra.cls ? " " + extra.cls : "") },
    h("span", { class: "tno" }, String(i + 1).padStart(2, "0")),
    tokIcon({ symbol: t.symbol, mint: t.mint, icon: t.icon, verified: t.verified }),
    h("div", { style: "min-width:0" },
      h("p", { class: "who-top" }, h("span", { class: "sym" }, t.symbol), t.verified === false && h("span", { class: "flag" }, icon("warn", "i"), h("span", { class: "flag-t" }, "unverified")), hv && h("span", { class: "flag warn" }, "high value")),
      h("p", { class: "tx-flow" }, usd(t.usdIn), icon("arrow", "i"), h("b", { class: extra.gone ? "gone" : null }, `≈ ${outAmt(t.receive, o)} ${symOf(o)}`), extra.gone && h("span", { class: "gone-l" }, " · not received")),
      t.fee && extra.burn !== "none" && h("p", { class: "tx-burn" }, icon("flame", "i"), extra.burn === "did" ? `${int(t.fee.burned)} ${burnSym()} burned` : `fee ${usd(t.fee.usd)} · burns ${int(t.fee.burned)} ${burnSym()}`)),
    extra.right || h("div", { class: "tx-right" }, t.loss != null && h("span", { class: "loss" + (t.loss > 0.03 ? " mid" : ""), title: "Expected output compared with the market price" }, `${t.loss > 0 ? "−" : "+"}${Math.abs(t.loss * 100).toFixed(1)}%`, h("span", { class: "vm" }, " vs. market"), h("span", { class: "vm-s" }, " mkt"))),
    extra.details !== false && !extra.note && h("details", { "data-fk": "det-" + key }, h("summary", { "data-fk": "sum-" + key }, "details"), h("dl", { class: "kv" },
      t.minReceive != null && [h("dt", {}, "minimum received"), h("dd", {}, `${outAmt(t.minReceive, o)} ${symOf(o)}`)],
      h("dt", {}, "expected"), h("dd", {}, `${outAmt(t.outAmount, o)} ${symOf(o)}${t.fee ? " before the fee" : ""}`),
      t.fee && [h("dt", {}, "fee"), h("dd", {}, `${outAmt(t.fee.amountIn, o)} ${symOf(o)} (${usd(t.fee.usd)})`)],
      h("dt", {}, "selling"), h("dd", {}, `${amt(t.amount)} ${t.symbol}`),
      h("dt", {}, "mint"), h("dd", { class: "mono" }, short(t.mint)))),
    extra.note);
}
function svgArrow() {
  return svgEl("svg", { class: "ch-arrow", viewBox: "0 0 64 24", "aria-hidden": "true" },
    svgEl("path", { d: "M2 12h56m-9-8 9 8-9 8", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }));
}
// What the wallet's balance change will show for the output. With SOL out and accounts being closed, the
// rent refunds land in the same SOL balance, so say both numbers instead of letting the wallet look "wrong".
function receiveLine(p, t, n) {
  const o = p.out, closes = p.set.close ? n : 0;
  const main = `≈ ${outAmt(t.receive, o)} ${symOf(o)}`;
  if (o.id === SOL && closes) return [h("b", {}, main), ` from the swaps${p.feeApplied ? " (after the fee)" : ""}, plus about `, h("b", {}, `${(closes * RENT_SOL).toFixed(4)} SOL`), " of rent back from closed accounts"];
  return [h("b", {}, main), p.feeApplied ? ", already after the fee" : ""];
}
// renderCut rebuilds its lists; whatever had focus (or was expanded) comes back afterwards, so a quote expiring
// or a chunk landing never throws a keyboard or screen-reader user back to the top of the page
const CUT_ZONES = "#cutHero, #cutList, #cutSkipped, #cutAside";
function renderCut() {
  const act = document.activeElement;
  const fk = act && act !== document.body && act.closest?.(CUT_ZONES) ? act.dataset.fk || null : null;
  const lostFocus = !!(act && act.closest?.(CUT_ZONES)) && !fk;
  const openKeys = $$("details[open][data-fk]", $('.scene[data-scene="cut"]')).map((d) => d.dataset.fk);
  drawCut();
  for (const k of openKeys) { const d = document.querySelector(`details[data-fk="${CSS.escape(k)}"]`); if (d) d.open = true; }
  if (fk) {
    const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (el && !el.disabled) el.focus({ preventScroll: true }); else if (!cta.disabled) cta.focus({ preventScroll: true });
  } else if (lostFocus && !document.activeElement?.closest?.(CUT_ZONES) && !cta.disabled) cta.focus({ preventScroll: true });
}
function drawCut() {
  const b = state.building, p = state.plan;
  const heroEl = $("#cutHero"), list = $("#cutList"), aside = $("#cutAside"), skipEl = $("#cutSkipped"), note = $("#cutNotice"), warn = $("#cutWarn");
  $("#cutProgress").hidden = !b;
  $("#cutBack").lastChild.textContent = b ? "cancel and go back" : "back to the pockets";
  note.hidden = !state.notice || !!b;
  if (state.notice) fill(note, icon("info"), h("span", {}, state.notice));
  const o0 = b?.out || p?.out;
  // an unverified output is flagged at the moment of approval, with its full address
  warn.hidden = !unverifiedOut(o0);
  if (unverifiedOut(o0)) fill(warn, icon("warn"), h("span", {}, h("b", {}, "You’re swapping into an unverified token. "), "It’s labelled ", h("span", { class: "data" }, o0.symbol || "?"), " but isn’t on Jupiter’s verified list, and names can be copied. Address: ", h("span", { class: "mono mint-inline" }, o0.id)));
  heroEl.classList.toggle("compact", !!b);
  heroEl.classList.toggle("stale", !b && !!state.stale);
  if (b) {
    const o = b.out;
    $("#cut-title").textContent = "polishin’ the route…";
    $("#cutFacts").textContent = "Quoting and simulating every swap. Nothing gets signed.";
    $("#cutFill").style.width = Math.max(4, (b.done / b.total) * 100) + "%";
    const lo = Math.min(b.done + 1, b.total), hi = Math.min(b.done + CHUNK, b.total);
    $("#cutProgLabel").textContent = b.done < b.total ? `${b.done} of ${b.total} routed · quoting ${lo === hi ? lo : `${lo}–${hi}`}…` : `${b.total} of ${b.total} routed`;
    fill(heroEl, h("p", { class: "ch-line" },
      h("b", {}, plural(b.total, "token")), h("span", {}, ` ≈ ${usd(b.items.reduce((a, it) => a + (rowBy(it.mint)?.usd || 0), 0))}`), icon("arrow", "i"), h("b", { class: "ch-line-out" }, symOf(o))));
    $("#cutListLabel").replaceChildren(h("span", {}, "routing"));
    list.replaceChildren(...b.items.map((it, i) => {
      const r = rowBy(it.mint) || { mint: it.mint };
      return h("li", { class: "tx" },
        h("span", { class: "tno" }, String(i + 1).padStart(2, "0")), tokIcon(r),
        h("div", { style: "min-width:0" }, h("p", { class: "sym" }, tokLabel(r)), h("p", { class: "tx-flow" }, usd(r.usd), icon("arrow", "i"), symOf(o))),
        h("div", { class: "tx-right" }, it.st === "queued" ? h("span", { class: "pill" }, "queued")
          : it.st === "routing" ? h("span", { class: "pill" }, h("span", { class: "spin" }), "routing")
          : it.st === "ready" ? h("span", { class: "pill ready" }, icon("check", "i"), "ready")
          : h("span", { class: "pill skip" }, "skipped")));
    }));
    skipEl.hidden = true;
    fill(aside, h("div", { class: "card" }, h("p", { class: "overline" }, "while you wait"), h("ul", { class: "ask-list" },
      h("li", {}, icon("spark"), h("span", {}, "Balances and prices are re-read on the server. Amounts from this page are never trusted.")),
      h("li", {}, icon("spark"), h("span", {}, "Every transaction is simulated before you see it.")),
      h("li", {}, icon("spark"), h("span", {}, "Tokens that can’t route safely get skipped, with the reason.")))));
    return;
  }
  if (!p) return;
  const o = p.out, n = p.txs.length, t = planTotals(p), busy = !!state.busy, rl = allRateLimited(p);
  const noSol = shortOfSol(p);
  $("#cut-title").textContent = n ? (state.stale ? "quotes went stale" : "review the cut") : rl ? "preview paused" : noSol ? "short on SOL" : "nothing made the cut";
  $("#cutFacts").textContent = n && state.stale
    ? (state.staleWhy === "settings" ? "These quotes used your old protection settings. Refresh to quote again with the new ones, then approve. Nothing was sent."
      : `The oldest of these quotes is more than ${TTL_MS / 1000} seconds old, so prices may have moved. Refresh to get fresh ones, then approve. Nothing was sent.`)
    : n ? `${plural(n, "token")} ready, one transaction each${p.feeApplied ? ", each with its own buy and burn" : ""}. Your wallet will ask once for all ${n}.${p.skipped.length ? ` Another ${p.skipped.length} ${p.skipped.length === 1 ? "was" : "were"} skipped (reasons below).` : ""}`
    : rl ? "Spacedust is rate-limiting previews for a moment. Nothing was built or signed. Try again when the timer runs out."
    : noSol ? `Swaps need a little SOL on hand while they run${typeof p.solLamports === "number" ? `, and this wallet has ${solAmt(p.solLamports)} SOL` : ""}. Nothing was built or signed. Fixes are below.`
    : "None of these tokens could be swapped safely right now. Nothing was built or signed. Reasons and fixes are below.";
  fill(heroEl,
    h("div", { class: "ch-block" }, h("p", { class: "overline" }, "you sell"), h("p", { class: "ch-big" }, plural(n, "token")), h("p", { class: "ch-sub" }, `worth ≈ ${usd(t.usdIn)}`)),
    svgArrow(),
    h("div", { class: "ch-block ch-out" }, h("p", { class: "overline" }, "you get", state.stale && n && h("span", { class: "old-tag" }, "old quote")), h("p", { class: "ch-big" }, `≈ ${outAmt(t.receive, o)}`, h("small", {}, symOf(o))),
      h("p", { class: "ch-sub" }, t.minReceive != null ? `at least ${outAmt(t.minReceive, o)} ${symOf(o)}${p.feeApplied ? ", after the fee" : ""}` : p.feeApplied ? "after the fee" : "")));
  fill($("#cutListLabel"), h("span", {}, `tracklist · ${plural(n, "transaction")}`), n > 0 && h("span", { class: "tl-col" }, "vs. market"));
  const animate = !p._shown && !reduced();
  list.replaceChildren(...t.items.map((x, i) => {
    const li = txRow(x, i, { cls: state.stale ? "stale" : "", out: o });
    if (animate) li.animate([{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], { duration: 380, delay: Math.min(i, 14) * 35, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    return li;
  }));
  p._shown = true;
  // skipped: bonus tracks, in plain words, with fixes. Identical reasons share one line.
  skipEl.hidden = !p.skipped.length;
  if (p.skipped.length) {
    const hs = p.skipped.map((s) => ({ s, hm: humanSkip(s, p) }));
    const lossNeed = Math.max(0, ...hs.map((x) => x.hm.loss || 0));
    const retry = retryableMints(p);
    const groups = [];
    for (const x of hs) { const g = groups.find((gg) => gg.why === x.hm.why); if (g) g.items.push(x); else groups.push({ why: x.hm.why, items: [x] }); }
    const symList = (items) => { const s = items.map(({ s }) => tokLabel(rowBy(s.mint) || { mint: s.mint })); return s.length > 6 ? `${s.slice(0, 6).join(", ")} +${s.length - 6} more` : s.join(", "); };
    fill(skipEl,
      h("p", { class: "overline" }, h("span", {}, `bonus tracks · skipped ${p.skipped.length}`)),
      groups.map(({ items }, gi) => {
        const { hm } = items[0];
        return h("div", { class: "skip-row" },
          h("span", { class: "tno" }, String(n + gi + 1).padStart(2, "0")),
          h("div", { style: "min-width:0" }, h("span", { class: "skip-sym" }, symList(items)), items.length > 1 && h("span", { class: "skip-n" }, ` · ${items.length} tokens`), h("p", { class: "skip-why" }, hm.why), hm.note && h("p", { class: "hint" }, hm.note),
            hm.raw && items.length === 1 && h("details", { "data-fk": "raw-" + items[0].s.mint }, h("summary", { "data-fk": "rawsum-" + items[0].s.mint }, "technical details"), h("span", { class: "mono" }, hm.raw)),
            hm.cleanup && lowSolFix(busy),
            hm.fix === "sol" && h("div", { class: "skip-fix" }, h("button", { class: "btn-ghost sm", type: "button", "data-fk": "fix-sol-" + gi, disabled: busy, onclick: () => { if (state.busy) return; setOut(DEFAULT_OUTS[0]); startPreview(p.mints); } }, "preview into SOL instead"))));
      }),
      h("div", { class: "skip-fix", style: "margin-top:12px" },
        lossNeed > 0 && h("button", { class: "btn-ghost sm", type: "button", "data-fk": "fix-loss", disabled: busy, onclick: () => raiseLoss(lossNeed, p) }, `allow up to ${lossNeed}% loss on every token and preview again`),
        retry.length > 0 && h("button", { class: "btn-text sm", type: "button", "data-fk": "fix-retry", "data-cd": n ? `preview again, retrying ${retry.length} skipped` : "try again", disabled: busy || cooldownLeft() > 0,
          onclick: () => { if (state.busy || cooldownLeft() > 0) return; startPreview(n ? [...readyMints(p), ...retry] : p.mints, { reuse: n ? youngTxs(p) : null }); } },
          icon("refresh", "i i-sm"), h("span", { class: "cd-l" }, n ? `preview again, retrying ${retry.length} skipped` : "try again"))));
    syncCooldownButtons();
  }
  // aside: what the wallet will ask first (the approval facts), then the burn, then protection
  const cards = [];
  const bMint = p.burnMint || burnId();
  if (n) {
    const closes = p.set.close ? n : 0;
    cards.push(h("div", { class: "card ask-card" },
      h("p", { class: "overline" }, "what your wallet will ask"),
      h("h3", {}, `1 prompt · ${plural(n, "transaction")}`),
      h("ul", { class: "ask-list" },
        unverifiedOut(o) && h("li", { class: "ask-warn" }, icon("warn", "i warn"), h("span", {}, h("b", {}, "You’ll receive an unverified token. "), "Check its address in your wallet: ", h("span", { class: "mono mint-inline" }, o.id))),
        h("li", {}, icon("wallet"), h("span", {}, h("b", {}, `${state.wallet?.name || "Your wallet"} opens once`), " and asks you to approve ", h("b", {}, plural(n, "transaction")), ". Each one sells one token.")),
        h("li", {}, icon("arrow"), h("span", {}, "Coming in: ", receiveLine(p, t, n), ". Give or take slippage.")),
        p.feeApplied && h("li", {}, icon("flame", "i pink"), h("span", {}, `${burnSym()} is bought and burned inside each transaction, so it may show as 0 or a tiny + amount.`)),
        h("li", {}, icon("bolt"), h("span", {}, "Network fee is a fraction of a cent of SOL per transaction. A first-time token account for what you receive costs about 0.002 SOL of rent.")),
        closes > 0 && o.id !== SOL && h("li", {}, icon("refresh"), h("span", {}, `Closing ${plural(closes, "emptied account")} gives back about ${(closes * RENT_SOL).toFixed(4)} SOL of rent.`)),
        h("li", {}, icon("spark"), h("span", {}, "Check the balance changes it shows. Spacedust never holds your funds or keys, and nothing is sent until you approve.")))));
  }
  if (p.feeApplied && n) cards.push(h("div", { class: "burn-card frame" },
    h("p", { class: "overline pink" }, "the burn"),
    h("p", { class: "big-burn" }, int(t.burned), h("small", {}, burnSym())),
    h("p", { class: "hint", style: "color:var(--lav-2)" }, `Bought with the ${p.feeBps ? pct(p.feeBps) : ""} fee (${outAmt(t.feeAmt, o)} ${symOf(o)} · ${usd(t.feeUsd)}) and burned inside the same ${plural(n, "transaction")}. Nobody receives it.`),
    bMint && h("div", { class: "mint-row" }, h("span", { class: "mono mint-full" }, bMint), h("button", { class: "icon-btn", type: "button", "data-copy": "mint", "data-fk": "copy-mint", "aria-label": "Copy the burn token mint address" }, icon("copy")))));
  else if (n && (fee() || p.feeApplied === false)) cards.push(h("div", { class: "burn-card frame nofee-state" }, h("p", { class: "overline green" }, "no fee"), h("p", { class: "hint", style: "color:var(--lav-2)" }, isBurnOut(o) ? `You’re swapping into ${burnSym()}, so nothing extra is bought or burned.` : "No fee is added to these transactions.")));
  cards.push(h("div", { class: "set-card" }, h("div", {}, h("p", { class: "overline" }, "protection"), h("p", { class: "set-sum" }, $("#setSum").textContent)),
    h("button", { class: "btn-ghost sm", type: "button", popovertarget: "setPop", "data-fk": "aside-edit", disabled: busy }, icon("gear", "i i-sm"), "edit")));
  aside.replaceChildren(...cards);
}
// A skipped token's fix can raise the loss limit, but the label says it applies to every token, the raised
// value is for this session only, and the toast can undo it.
function raiseLoss(need, p) {
  if (state.busy) return;
  const from = state.tempLoss?.from ?? state.set.loss;
  if (!applySettings({ ...state.set, loss: Math.max(state.set.loss, need) }, { persist: false, quiet: true })) return;
  state.tempLoss = { from };
  startPreview(p.mints);
  toast({ title: `max loss is now ${state.set.loss}% for every token`, body: `This session only. Your saved limit stays ${from}%.`, timeout: 9000,
    actions: [{ label: `undo, back to ${from}%`, run: () => {
      if (state.busy === "signing" || state.busy === "sending") return;
      if (state.busy === "building") { state.building?.ctrl?.abort(); state.epoch++; state.building = null; setIdle(); }
      state.set = { ...state.set, loss: from }; state.tempLoss = null; renderSetSummary();
      startPreview(p.mints);
    } }] });
}

/* quote freshness ring: counts down from the oldest quote in the plan */
let ringT = null;
function startRing() { stopRing(); renderRing(); ringT = setInterval(renderRing, 1000); }
function stopRing() { clearInterval(ringT); ringT = null; }
function renderRing(rerender = true) {
  if (!state.plan || state.scene !== "cut" || state.plan.sent) return;
  const age = Math.max(0, Math.round((Date.now() - state.planAt) / 1000));
  const left = state.stale ? 0 : Math.max(0, Math.ceil((TTL_MS - (Date.now() - state.planAt)) / 1000));
  const ring = $("#ring");
  $("#ringFg").style.strokeDashoffset = String(97.4 * (1 - left / (TTL_MS / 1000)));
  $("#ringText").textContent = left ? left + "s" : "exp";
  $("#ringCap").textContent = left ? "fresh" : "stale";
  ring.classList.toggle("low", left <= 10);
  ring.classList.toggle("expired", !left);
  ring.setAttribute("aria-label", left ? `Quotes are fresh for ${left} more seconds. The oldest quote is ${age} seconds old.` : "Quotes expired. Refresh before approving.");
  if (!left && !state.stale && rerender && state.busy == null) { state.stale = true; state.staleWhy = "time"; stopRing(); renderCut(); renderBar(); setPose(sceneMascot("cut"), 1); srSay("Quotes expired. Refresh before approving."); }
}

/* ================= SC. 03 · the wallet prompt (cinema mode) ================= */
// the signed transaction's recentBlockhash (compact-u16 signature count, signatures, optional version byte,
// 3-byte header, compact-u16 account count, account keys, then the blockhash)
function cu16(b, o) { let v = 0, s = 0, i = 0; for (;;) { const x = b[o + i++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; if (i > 3) throw 0; } return [v, o + i]; }
function blockhashOf(b64) {
  try {
    const b = b64ToBytes(b64);
    let [n, off] = cu16(b, 0); off += 64 * n;
    if (b[off] & 0x80) off++;
    off += 3;
    let k; [k, off] = cu16(b, off); off += 32 * k;
    return off + 32 <= b.length ? b58(b.subarray(off, off + 32)) : null;
  } catch { return null; }
}
function accountMoved() {
  state.plan = null; state.stale = false; stopRing();
  state.rc = rcFresh();
  const live = state.wallet?.accounts;
  if (!state.pendingAccounts && Array.isArray(live) && live.length && !live.some((a) => a.address === state.account?.address)) state.pendingAccounts = { w: state.wallet, accounts: [...live] };
  if (state.pendingAccounts) return setIdle(); // applies the switch and reloads balances
  toast({ title: "the wallet account changed", body: "Balances are reloading for the account that’s connected now. Nothing was signed or sent." });
  go("pockets", { back: true }).then(() => loadHoldings());
}
async function approve() {
  const p = state.plan;
  if (!p || !p.txs.length || state.busy || p.sent) return; // a plan is never signed twice once anything went out
  if (state.pendingAccounts || p.owner !== state.account?.address || !liveAccountOk(p.owner)) return accountMoved();
  // a stale plan would fail on-chain or fill at old prices, so re-quote it and let the user check again
  if (state.stale || Date.now() - state.planAt > TTL_MS) return refreshQuotes({ notice: "Prices move, so the preview was refreshed. Check it again, then approve." });
  const feature = state.wallet?.features?.["solana:signTransaction"];
  if (!feature) { toast({ title: "this wallet can’t sign here", body: "Pick a wallet that supports Solana transaction signing.", tone: "bad" }); return; }
  closeAllPops(); clearToasts();
  const ep = state.epoch;
  state.busy = "signing"; state.signing = "swap"; state.notice = null;
  $("#main").inert = true; // nothing on the page changes between this click and the wallet's answer
  stopRing(); renderCut(); renderBar();
  const unlock = () => { $("#main").inert = false; };
  let fresh;
  try {
    // a transaction is only valid for ~60s after its blockhash, so stamp a fresh one right before the prompt
    fresh = await api("/api/refresh", { txs: p.txs.map((t) => t.tx) });
    if (!Array.isArray(fresh?.txs) || fresh.txs.length !== p.txs.length) throw new ApiError("The server returned the wrong number of transactions.", 500);
  } catch (e) {
    if (ep !== state.epoch) return;
    unlock(); setIdle(); startRing(); renderCut(); renderBar();
    if (e.status === 429) startCooldown(30);
    toast({ title: "couldn’t prepare the transactions", body: `${e.message} Nothing was signed or sent.`, tone: "bad" });
    return;
  }
  if (ep !== state.epoch) return;
  // last look before the prompt: the plan must still match the settings, the output and the live account
  const acct = state.wallet?.accounts?.find?.((a) => a.address === p.owner) || state.account;
  if (state.stale || JSON.stringify(p.set) !== JSON.stringify(state.set) || p.out.id !== state.out.id || state.pendingAccounts || p.owner !== state.account?.address || !liveAccountOk(p.owner)) {
    unlock(); setIdle();
    if (state.pendingAccounts || p.owner !== state.account?.address || !liveAccountOk(p.owner)) return accountMoved();
    return startPreview(p.mints, { notice: "Something changed while the transactions were being prepared, so the preview was rebuilt. Check it again, then approve." });
  }
  showCinema(swapCinema());
  let signed;
  try {
    const res = await feature.signTransaction(...fresh.txs.map((tx) => ({ account: acct, transaction: b64ToBytes(tx), chain: "solana:mainnet" })));
    if (ep !== state.epoch) return; // the user stopped waiting: a late signature is dropped and never sent
    if (!Array.isArray(res) || res.length !== p.txs.length) throw new Error("The wallet returned a different number of transactions than it was asked to sign.");
    signed = res.map((r) => bytesToB64(r.signedTransaction));
  } catch (e) {
    if (ep !== state.epoch) return;
    hideCinema();
    setIdle();
    const fresh2 = Date.now() - state.planAt < TTL_MS;
    if (fresh2) startRing(); else { state.stale = true; state.staleWhy = "time"; }
    renderCut(); renderBar();
    toast(isReject(e)
      ? { title: "cancelled in wallet. nothing was sent", body: fresh2 ? "The preview is still fresh. Approve again when you’re ready." : "Refresh the quotes whenever you’re ready." }
      : { title: "the wallet couldn’t sign", body: `${String(e?.message || e).slice(0, 160)} Nothing was sent.`, tone: "bad" });
    setPose(sceneMascot("cut"), 4);
    setTimeout(() => setPose(sceneMascot("cut"), 19, { hop: false }), 1600);
    return;
  }
  p.sent = true; // from here on this plan can only be retried as a fresh preview
  hideCinema();
  // the expiry rule only applies when the wallet kept the blockhash /api/refresh stamped
  const want = fresh.txs.map(blockhashOf);
  runSend(signed, fresh.lastValidBlockHeight, signed.map((s, i) => !!want[i] && blockhashOf(s) === want[i]));
}
let hintT;
// what the cinema says while the wallet is open, for a swap plan
function swapCinema() {
  const p = state.plan, n = p.txs.length, o = p.out, t = planTotals(p);
  return { n, facts: `${state.wallet?.name || "Your wallet"} is asking you to approve ${plural(n, "transaction")} in one prompt. Check the balance changes it shows. Nothing is sent until you approve.`,
    items: [
      unverifiedOut(o) && h("li", { class: "ask-warn" }, icon("warn", "i warn"), h("span", {}, h("b", {}, "Unverified token coming in. "), "Its address: ", h("span", { class: "mono mint-inline" }, o.id))),
      h("li", {}, icon("spark"), h("span", {}, "You’ll see ", h("b", {}, `${plural(n, "token")} leaving`), ". Coming in: ", receiveLine(p, t, n), ".")),
      p.feeApplied && h("li", {}, icon("flame", "i pink"), h("span", {}, `${burnSym()} may show as 0. It’s bought and burned inside each transaction.`)),
      h("li", {}, icon("spark"), h("span", {}, "Spacedust never holds your funds or keys. Your wallet signs."))] };
}
function showCinema({ n, facts, items }) {
  closeAllPops();
  state.cinemaN = n;
  $("#cinemaFacts").textContent = facts;
  fill($("#cinemaList"), items);
  $("#cinemaStuck").hidden = true;
  clearTimeout(hintT); hintT = setTimeout(() => { $("#cinemaStuck").hidden = false; }, 15000);
  const c = $("#cinema"); c.classList.remove("out"); c.hidden = false;
  root.classList.add("cinema-on");
  // Dusty goes to work on loop while the wallet is open (the poster frame holds still for reduced motion)
  const reel = $("#cinemaReel");
  reel.preload = "auto";
  if (!reduced()) { reel.currentTime = 0; reel.play().catch(() => {}); }
  $("#main").inert = true; $("#barTop").inert = true; $("#barBot").inert = true;
  c.focus({ preventScroll: true });
  renderSlate(); renderBar();
}
function hideCinema(instant = false) {
  clearTimeout(hintT);
  $("#cinemaReel").pause();
  const c = $("#cinema");
  root.classList.remove("cinema-on");
  $("#main").inert = false; $("#barTop").inert = false; $("#barBot").inert = false;
  renderSlate();
  if (c.hidden) return;
  if (instant || reduced()) { c.hidden = true; return; }
  c.classList.add("out"); setTimeout(() => { c.hidden = true; c.classList.remove("out"); }, 300);
}
// The way out when a wallet never answers (popup closed by the OS, wallet locked, extension crashed). Safe:
// bumping the epoch means a signature that arrives later is dropped and never broadcast.
function stopWaiting() {
  if (state.busy !== "signing" || !root.classList.contains("cinema-on")) return;
  const kind = state.signing;
  state.epoch++;
  hideCinema(); setIdle();
  if (kind === "reclaim") {
    renderCleanup(); renderBar();
    cta.focus({ preventScroll: true });
    setPose(sceneMascot("cleanup"), 1);
    toast({ title: "stopped waiting for the wallet", body: "Nothing was sent. If your wallet still shows the request, reject it there. Approve again whenever you’re ready." });
    return;
  }
  state.stale = true; state.staleWhy = "time";
  renderCut(); renderBar();
  cta.focus({ preventScroll: true });
  setPose(sceneMascot("cut"), 1);
  toast({ title: "stopped waiting for the wallet", body: "Nothing was sent. If your wallet still shows the request, reject it there. Refresh the quotes to try again." });
}
$("#cinemaBack").addEventListener("click", stopWaiting);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("cinema-on")) { e.preventDefault(); stopWaiting(); } });

/* ================= SC. 04 · send + confirm ================= */
function humanErr(err, kind = "swap") {
  const s = JSON.stringify(err) || "";
  if (/InsufficientFundsForFee|InsufficientFundsForRent/.test(s)) return "Not enough SOL for network fees.";
  const m = s.match(/"Custom":(\d+)/);
  if (kind === "reclaim") {
    if (m && +m[1] === 11) return "An account received tokens after the review, so it couldn’t be closed.";
    if (m && +m[1] === 17) return "An account was frozen by its token’s issuer.";
    if (/BlockhashNotFound/.test(s)) return "It expired before it landed.";
    return "It failed on-chain.";
  }
  if (m && [6001, 6017, 6024].includes(+m[1])) return "The price moved past your slippage limit.";
  if (m && +m[1] === 1) return "Not enough balance for this swap.";
  if (/BlockhashNotFound/.test(s)) return "It expired before it landed.";
  return "It failed on-chain.";
}
const CHECKING = "No clear answer from the network yet, so Spacedust is checking by signature…";
// What a transaction that didn't land means, per flow. Everything else about sending and confirming is shared.
const SWAP_COPY = {
  kind: "swap",
  notSent: (err) => `Didn’t send: ${err}. Nothing happened, and the token is still in your wallet.`,
  failed: "Nothing was swapped or burned; only the network fee was paid. The token is still in your wallet.",
  expired: "Expired: it never landed, so nothing happened. The token is still in your wallet.",
  late: "Didn’t confirm in time, so it most likely expired without doing anything. Check your wallet history, then preview again. The token should still be in your wallet.",
};
const RC_COPY = {
  kind: "reclaim",
  notSent: (err) => `Didn’t send: ${err}. Nothing happened, and these accounts are still open.`,
  failed: "Nothing in it was closed or burned; only the network fee was paid. These accounts are still open.",
  expired: "Expired: it never landed, so nothing happened. These accounts are still open.",
  late: "Didn’t confirm in time, so it most likely expired without doing anything. Check your wallet history, then try the rest again.",
};
async function runSend(signed, lastValid, keptHash = []) {
  const ep = ++state.epoch;
  const p = state.plan, t = planTotals(p);
  const lv = Number.isFinite(lastValid) ? lastValid : null;
  state.busy = "sending";
  state.run = { kind: "swap", items: t.items.map((x, i) => ({ ...x, i, status: "sending", sig: sigOf(signed[i]), note: null, lastValid: keptHash[i] ? lv : null, past: 0 })), done: false, out: p.out, feeApplied: p.feeApplied, burnMint: p.burnMint, close: p.set.close, sim: !!dev?.simulated };
  await go("drop");
  if (ep !== state.epoch) return;
  $("#stampWrap").hidden = true; $("#result").hidden = true; $("#drop-title").classList.remove("as-stamp"); showComplete(false);
  $("#drop-title").textContent = "sendin’ it";
  $("#dropFacts").textContent = `${plural(p.txs.length, "transaction")} signed. Sending them now. Each one lands on its own, so a slow one never holds up the rest.`;
  renderSimNote();
  setPose(sceneMascot("drop"), 6, { mode: "wiggle" });
  renderDrop(); renderBar();
  const items = state.run.items;
  if (!(await sendAndTrack(items, signed, ep, SWAP_COPY))) return;
  state.run.done = true; setIdle();
  state.selected.clear();
  renderDrop(); renderResult(); renderBar();
  const c = items.filter((i) => i.status === "confirmed").length;
  srSay(`${c} of ${items.length} confirmed.`);
  // confirmed tokens leave the list in the background, without flashing it; the accounts read after it so the
  // "reclaim rent" offer on the result reflects the accounts this run just closed
  loadHoldings({ silent: true }).then(() => loadAccounts({ silent: true }));
}
// Relays signed transactions and follows each one by signature until it confirms, fails, or can no longer land.
// Returns false if the user moved on meanwhile (the epoch changed), in which case nothing more is rendered.
async function sendAndTrack(items, signed, ep, copy) {
  try {
    const sigs = await api("/api/send", { txs: signed });
    if (ep !== state.epoch) return false;
    if (!Array.isArray(sigs) || sigs.length !== items.length) throw new Error("unexpected response");
    items.forEach((it, i) => {
      const s = sigs[i];
      if (typeof s === "string") { it.sig = s; it.status = "confirming"; return; }
      const err = String(s?.error || "rejected by the network");
      // only a preflight rejection or the RPC refusing the send is definitive; anything else may still land, so
      // keep watching the signature
      const definitive = !s?.uncertain && /simulation failed|expired|busy/.test(err);
      if (it.sig && !definitive) { it.status = "confirming"; it.note = CHECKING; }
      else { it.status = "never"; it.note = copy.notSent(err); }
    });
  } catch (e) {
    if (ep !== state.epoch) return false;
    // The relay answer failed or made no sense, so we can't be sure what reached the network. Track by signature.
    items.forEach((it) => { if (it.sig) { it.status = "confirming"; it.note = CHECKING; } else { it.status = "never"; it.note = `Didn’t send: ${e.message} Nothing happened.`; } });
  }
  renderDrop(); renderBar();
  const pending = () => items.filter((it) => it.status === "confirming");
  let delay = 2000, fails = 0, polls = 0;
  const started = Date.now();
  while (pending().length) {
    await sleep(delay);
    if (ep !== state.epoch) return false;
    const pend = pending();
    // the block height is only needed to settle expiry: ask for it every third poll, once a minute has gone
    // by, or right after it first looked expired (expiry needs two looks in a row)
    const withH = polls++ % 3 === 2 || Date.now() - started > 50_000 || pend.some((it) => it.past);
    try {
      const res = await api(`/api/status?${withH ? "h=1&" : ""}sigs=${pend.map((it) => it.sig).join(",")}`);
      if (ep !== state.epoch) return false;
      const statuses = Array.isArray(res) ? res : res?.statuses || [];
      const bh = Array.isArray(res) ? null : res?.blockHeight;
      fails = 0; delay = 2000;
      pend.forEach((it, k) => {
        const s = statuses[k];
        if (!s) return;
        it.landed = true; it.past = 0;
        if (s.err) { it.status = "failed"; it.note = `${humanErr(s.err, copy.kind)} ${copy.failed}`; }
        else if (s.status === "confirmed" || s.status === "finalized") { it.status = "confirmed"; it.note = null; }
        else it.processed = true;
      });
      // past its last valid block height without landing, a transaction can never land. Two looks in a row,
      // because the RPC nodes behind one endpoint can disagree for a moment.
      if (Number.isFinite(bh)) for (const it of pending()) {
        if (it.landed || it.lastValid == null) continue;
        if (bh > it.lastValid) { if (++it.past >= 2) { it.status = "expired"; it.note = copy.expired; } }
        else it.past = 0;
      }
    } catch { fails++; delay = Math.min(12000, 2000 * 2 ** fails); } // back off and keep polling; never give up on the first error
    if (Date.now() - started > 150_000)
      for (const it of pending()) { it.status = "expired"; it.note = it.landed ? "Still not confirmed. Check your wallet history before trying again." : copy.late; }
    renderDrop(); renderBar();
  }
  return ep === state.epoch;
}
function renderSimNote() {
  const el = $("#simNote");
  el.hidden = !state.run?.sim;
  if (state.run?.sim) fill(el, icon("info"), h("span", {}, h("b", {}, "Dev simulation. "), "Nothing was signed or sent on-chain. Signatures and outcomes below are fixtures."));
}
function renderChain(items) {
  const wrap = $("#chain"), n = items.length;
  const step = 36, W = Math.max(n * step + 30, 60);
  let svg = wrap.querySelector("svg");
  if (!svg || svg.dataset.n !== String(n)) {
    // sized to its links, so the count sits right after the chain instead of across the page
    svg = svgEl("svg", { viewBox: `0 0 ${W} 48`, preserveAspectRatio: "xMinYMid meet", "data-n": String(n), style: `width:${W}px` });
    items.forEach((_, i) => {
      const odd = i % 2 === 1, w = 52, hh = odd ? 22 : 34, x = 3 + i * step, y = 24 - hh / 2;
      svg.append(svgEl("g", { class: "link-g pending", "data-i": String(i) },
        svgEl("rect", { class: "body", x, y, width: w, height: hh, rx: hh / 2 }),
        svgEl("rect", { class: "hi", x: x + 3, y: y + 2.5, width: w - 6, height: Math.max(4, hh - 5), rx: (hh - 5) / 2, fill: "none" })));
    });
    wrap.replaceChildren(svg);
  }
  items.forEach((it, i) => {
    const g = svg.querySelector(`[data-i="${i}"]`);
    const cls = it.status;
    if (!g.classList.contains(cls)) {
      g.setAttribute("class", "link-g " + cls);
      if (cls === "confirmed" && !reduced()) g.classList.add("glint");
      if (cls === "failed" && !reduced()) g.classList.add("flash");
    }
  });
}
function renderDrop() {
  const r = state.run; if (!r) return;
  const o = r.out, items = r.items, n = items.length;
  renderChain(items);
  const count = (s) => items.filter((i) => i.status === s).length;
  const c = count("confirmed"), f = count("failed"), e = count("expired"), nv = count("never");
  fill($("#chainCount"), `${c} of ${n} confirmed`, (f || e || nv) ? h("span", {}, [f && `${f} failed`, e && `${e} expired`, nv && `${nv} not sent`].filter(Boolean).join(" · ")) : "");
  if (r.kind === "reclaim") return renderReclaimDrop(r);
  $("#runList").replaceChildren(...items.map((t, i) => {
    const sol = t.sig && !r.sim && h("a", { class: "sol-link", href: "https://solscan.io/tx/" + encodeURIComponent(t.sig), target: "_blank", rel: "noreferrer" }, "view on Solscan", icon("ext", "i"));
    const right = h("div", { class: "tx-right" },
      t.status === "sending" ? h("span", { class: "pill" }, icon("bolt", "i"), "sending…")
      : t.status === "confirming" ? h("span", { class: "pill" }, h("span", { class: "spin" }), t.processed ? "processed…" : "confirming…")
      : t.status === "confirmed" ? h("span", { class: "pill ok" }, icon("check", "i"), "confirmed")
      : t.status === "failed" ? h("span", { class: "pill bad" }, icon("x", "i"), "failed")
      : t.status === "never" ? h("span", { class: "pill exp" }, "not sent")
      : h("span", { class: "pill exp" }, "expired"),
      (t.status === "confirmed" || t.status === "failed") && sol);
    const note = t.note ? h("p", { class: "tx-note" + (t.status === "failed" ? " bad" : "") }, t.note) : null;
    const gone = ["failed", "expired", "never"].includes(t.status);
    return txRow(t, i, { right, note, out: o, details: false, gone, burn: t.status === "confirmed" ? "did" : gone ? "none" : "will" });
  }));
}
function renderResult() {
  if (state.run?.kind === "reclaim") return renderReclaimResult();
  const r = state.run, o = r.out, items = r.items, n = items.length;
  const ok = items.filter((i) => i.status === "confirmed"), bad = items.filter((i) => i.status !== "confirmed");
  const recv = ok.reduce((a, t) => a + t.receive, 0), burned = ok.reduce((a, t) => a + (t.fee?.burned || 0), 0);
  const closed = r.close ? ok.length : 0, rent = closed * RENT_SOL;
  const res = $("#result"); res.hidden = false;
  const m = sceneMascot("drop");
  const title = $("#drop-title");
  if (!bad.length) {
    $("#dropFacts").textContent = `Every swap landed. About ${outAmt(recv, o)} ${symOf(o)} received (the quoted amount)${rent ? `, about ${rent.toFixed(4)} SOL of rent back` : ""}${burned ? `, ${int(burned)} ${burnSym()} burned` : ""}.`;
    $("#stampWrap").hidden = false; title.classList.add("as-stamp"); title.textContent = "dusted: all clean";
    $("#stampText").textContent = "dusted"; $("#stamp").classList.remove("long");
    const st = $("#stamp"); st.classList.remove("slam"); void st.offsetWidth; if (!reduced()) st.classList.add("slam");
    showComplete(true);
    feathers();
  } else if (!ok.length) {
    const allExp = bad.every((b) => b.status === "expired" || b.status === "never");
    title.classList.remove("as-stamp"); title.textContent = allExp ? "it expired before landing" : "nothing landed";
    $("#dropFacts").textContent = allExp ? "Solana transactions are only valid for about a minute, and these didn’t land in time. Nothing happened on-chain. Preview again to get fresh ones." : "None of these went through. Nothing was swapped or burned, and your tokens are still in your wallet. Details are below each one.";
    $("#stampWrap").hidden = true;
    showComplete(false);
    setPose(m, 1);
  } else {
    title.classList.remove("as-stamp"); title.textContent = "mostly clean";
    $("#dropFacts").textContent = `${bad.length} didn’t go through, and ${bad.length === 1 ? "that token is" : "those tokens are"} still in your wallet. The other ${ok.length} landed.`;
    $("#stampWrap").hidden = true;
    showComplete(false);
    setPose(m, 4);
  }
  if (!ok.length) { fill(res, h("p", { class: "result-note" }, "No swaps happened and no fee was taken. Your tokens haven’t moved.")); return; }
  const burnStat = h("div", { class: "stat burned" }, h("p", { class: "overline pink" }, "burned"), h("p", { class: "stat-v" }, h("span", { class: "odo-host" }), h("small", {}, burnSym())), h("p", { class: "stat-s" }, "bought with the fee, gone for good"));
  // what the user got leads; rent and the burn sit underneath
  fill(res,
    h("div", { class: "stats" },
      h("div", { class: "stat received" }, h("p", { class: "overline" }, "received · expected"), h("p", { class: "stat-v" }, `≈ ${outAmt(recv, o)}`, h("small", {}, symOf(o))), h("p", { class: "stat-s" }, `quoted, from ${plural(ok.length, "token")}${state.plan?.outPrice ? ` · ≈ ${usd(recv * state.plan.outPrice)}` : ""}. Your wallet shows the exact amount.`)),
      h("div", { class: "stat" }, h("p", { class: "overline" }, "rent back"), h("p", { class: "stat-v" }, rent ? `≈ ${rent.toFixed(4)}` : "0", h("small", {}, "SOL")), h("p", { class: "stat-s" }, rent ? `estimate: about 0.002 SOL for each of ${plural(closed, "closed account")}` : "accounts kept open")),
      r.feeApplied && burned ? burnStat : h("div", { class: "stat" }, h("p", { class: "overline" }, "fee"), h("p", { class: "stat-v" }, "0"), h("p", { class: "stat-s" }, isBurnOut(o) ? `no fee into ${burnSym()}` : "no fee on this run"))),
    h("div", { class: "result-actions" }, h("button", { class: "btn-ghost sm", type: "button", onclick: copySummary }, icon("copy", "i i-sm"), "copy summary"), h("span", { id: "resRc", class: "res-rc" })),
    bad.length > 0 && h("p", { class: "result-note" }, `“Preview ${bad.length === 1 ? "that one" : `the ${bad.length}`} again” builds a fresh preview of just ${bad.length === 1 ? "that token" : "those tokens"}. The ones that landed are done and won’t be sent again. Transactions that failed or expired took no fee.`));
  const host = burnStat.querySelector(".odo-host");
  if (r.feeApplied && burned) odometer(host, int(burned), burnStat);
  renderResultReclaim();
}
function odometer(host, str, stat) {
  if (reduced()) { host.textContent = str; return; }
  host.replaceChildren(h("span", { class: "odo", role: "img", "aria-label": str }, [...str].map((ch) => {
    if (!/\d/.test(ch)) return h("span", { "aria-hidden": "true" }, ch);
    return h("span", { class: "odo-col", "aria-hidden": "true" }, h("span", { class: "odo-strip" }, Array.from({ length: 20 }, (_, k) => h("span", {}, String(k % 10)))));
  })));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const digits = str.replace(/\D/g, "");
    host.querySelectorAll(".odo-strip").forEach((col, k) => { col.style.transitionDelay = k * 70 + "ms"; col.style.translate = `0 -${10 + Number(digits[k])}em`; });
    setTimeout(() => embers(stat), 600);
  }));
}
function embers(stat) {
  if (reduced() || !stat.isConnected) return;
  const v = stat.querySelector(".stat-v"), rect = v.getBoundingClientRect(), sr = stat.getBoundingClientRect();
  for (let i = 0; i < 6; i++) {
    const e = h("span", { class: "ember" });
    e.style.left = rect.left - sr.left + 10 + Math.random() * Math.min(160, rect.width) + "px";
    e.style.top = rect.top - sr.top + 6 + "px";
    e.style.setProperty("--dx", (Math.random() * 30 - 15).toFixed(0) + "px");
    e.style.animationDelay = i * 90 + "ms";
    stat.append(e);
    setTimeout(() => e.remove(), 1800);
  }
}
// When a whole run lands, the finished screen trades the mascot for Dusty with a stack of SOL.
const COMPLETE_ART = "/img/dusty/complete.webp";
function showComplete(on) {
  const art = $("#completeArt"), m = sceneMascot("drop");
  if (!art.getAttribute("src")) art.src = COMPLETE_ART;
  art.hidden = !on; m.hidden = on;
  art.classList.remove("pop");
  if (on && !reduced()) { void art.offsetWidth; art.classList.add("pop"); }
}
function feathers() {
  if (reduced()) return;
  const art = $("#completeArt");
  const m = (art.hidden ? sceneMascot("drop") : art).getBoundingClientRect();
  for (let i = 0; i < 9; i++) {
    const s = svgEl("svg", { class: "feather", viewBox: "0 0 24 24", "aria-hidden": "true" },
      svgEl("path", { d: "M4 20c3-9 8-14 16-16-1 8-6 13-14 15M6 18l7-8", fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round" }),
      svgEl("path", { d: "M5 19c3-8 8-12 14-14-2 7-6 11-14 14z", fill: "currentColor", opacity: ".45" }));
    s.style.left = m.left + m.width * (0.1 + Math.random() * 0.8) + "px";
    s.style.top = m.top + m.height * 0.1 + "px";
    s.style.setProperty("--dx", (Math.random() * 120 - 60).toFixed(0) + "px");
    s.style.setProperty("--rot", (Math.random() * 240 - 120).toFixed(0) + "deg");
    s.style.setProperty("--dur", (1.4 + Math.random() * 0.8).toFixed(2) + "s");
    s.style.animationDelay = (0.25 + i * 0.07).toFixed(2) + "s";
    document.body.append(s);
    setTimeout(() => s.remove(), 3200);
  }
}
async function copySummary() {
  const r = state.run, o = r.out, ok = r.items.filter((i) => i.status === "confirmed");
  const recv = ok.reduce((a, t) => a + t.receive, 0), burned = ok.reduce((a, t) => a + (t.fee?.burned || 0), 0);
  const text = `spacedust: ${ok.length} of ${r.items.length} confirmed. ≈ ${outAmt(recv, o)} ${symOf(o)} received${burned ? `, ${int(burned)} ${burnSym()} burned` : ""}.${r.sim ? " (dev simulation, nothing was sent)" : ""}\n` + ok.map((t) => `https://solscan.io/tx/${t.sig}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast({ title: "summary copied", tone: "ok", timeout: 2200 }); }
  catch { toast({ title: "couldn’t copy", body: "Your browser blocked clipboard access." }); }
}
function dustAgain() {
  if (state.busy) return;
  state.epoch++; state.run = null; state.plan = null;
  // straight from a cleanup that started on the landing: the pockets were never read for this wallet
  if (state.rowsFor !== state.account?.address) { go("pockets", { back: true }).then(() => loadHoldings()); return; }
  go("pockets", { back: true }).then(() => {
    autoSelect(true);
    setPose(sceneMascot("pockets"), state.rows.some((r) => r.usd != null) ? 2 : 13);
    renderPockets();
  });
}
// A retry is always a fresh preview of what didn't land. Balances are re-read first (so anything that did land
// drops out); the bar shows that, and a "done" in the meantime wins.
async function retryMints(items) {
  const r = state.run;
  if (state.busy || !r || r.retrying) return;
  const mints = items.flatMap((i) => i.mints || [i.mint]);
  const ep = ++state.epoch;
  r.retrying = true; renderBar();
  try { await loadHoldings({ silent: true }); } catch {}
  if (ep !== state.epoch || state.run !== r) return;
  state.run = null; state.plan = null;
  state.selected = new Set(mints.filter((m) => rowBy(m)));
  startPreview([...state.selected]);
}

/* ================= SC. 01 · the cleanup: rent back from token accounts ================= */
// Every token account locks ~0.002 SOL of rent. Empty ones can be closed and the rent goes back to the wallet,
// with no fee. Worthless dust can optionally be burned first (irreversible, off by default, confirmed by hand).
// The sign → send → confirm path is the swaps' own: /api/refresh right before one wallet prompt, /api/send,
// /api/status polling, never re-signed once anything went out.
const rcList = () => state.rc.accounts || [];
const rcMine = () => !!state.account && state.rc.owner === state.account.address;
const rcAcc = (addr) => rcList().find((a) => a.address === addr);
const rcEmpty = (a) => a.closable && a.amount === "0";
// NFTs: an account still holding one is never closed or burned, and isn't listed at all (one "left alone" line says
// how many). An EMPTY account whose mint is an NFT holds nothing (the NFT already left), so it's closable like any
// empty account, but it's listed in its own group so nobody mistakes it for a token.
// A collectible with no NFT marker (`tokenIfPriced`: decimals 0, nothing on-chain says NFT) is a 0-decimal coin when
// Jupiter prices it; the cleanup reads no prices, so the pockets list (same wallet, priced) settles it. Such a coin is
// held like any token (never burned: it has no decimals). Accounts the server couldn't check (`nftUnsure`) aren't
// called NFTs: held ones are counted apart, empty ones close with the rest.
const rcPricedCoin = (a) => a.tokenIfPriced && a.amount !== "0" && state.rowsFor === state.rc.owner && !!rowBy(a.mint);
const rcNftHeld = (a) => a.nft && !a.nftUnsure && a.amount !== "0" && !rcPricedCoin(a);
const rcUnsureHeld = (a) => a.nft && a.nftUnsure && a.amount !== "0";
const rcTokEmpty = (a) => rcEmpty(a) && (!a.nft || a.nftUnsure);
const rcNftEmpty = (a) => rcEmpty(a) && a.nft && !a.nftUnsure;
const rcWsol = (a) => a.closable && a.native && a.amount !== "0";
const rcCandidates = () => rcList().filter((a) => a.closable); // empty ones, plus wrapped SOL (closing unwraps it)
// "Burn & close": which accounts could be burned, value permitting, is known from the RPC read alone; which ones are
// actually offered needs prices, and those cost Jupiter quota, so they're read only once the burn section is opened.
const rcPricedOk = () => state.rc.priced && !state.rc.priceError;
const rcBurnCands = () => rcList().filter((a) => a.burnCandidate && !a.nft);
const rcBurnables = () => (rcPricedOk() ? rcList().filter((a) => a.burnable && !a.nft) : []);
// Priced dust under $1 can be picked all at once. Dust with no price has an unknown value (Jupiter has no price for
// plenty of tokens worth something), so it's listed apart and every one of those is ticked by hand.
const rcBurnPriced = () => rcBurnables().filter((a) => a.usd != null).sort((a, b) => a.usd - b.usd);
const rcBurnUnpriced = () => rcBurnables().filter((a) => a.usd == null);
const rcBlocked = (a) => !a.closable && !a.burnCandidate && a.reason !== "has balance" && !rcNftHeld(a) && !rcUnsureHeld(a) && !rcPricedCoin(a);
// still holding tokens the cleanup leaves alone: the burn token always, 0-decimal coins, and once priced, dust worth
// $1 or more
const rcHolding = () => rcList().filter((a) => rcPricedCoin(a) || (a.reason === "has balance" && !a.nft && (!a.burnCandidate || (rcPricedOk() && !a.burnable))));
// how many held accounts are left alone as NFTs, as collectibles, and unchecked
const rcAloneCounts = () => {
  const held = rcList().filter(rcNftHeld);
  const nfts = held.filter((a) => isNftKind(a.nftKind)).length;
  return { nfts, coll: held.length - nfts, unchecked: rcList().filter(rcUnsureHeld).length };
};
const rcHasWork = () => rcCandidates().length > 0 || (rcPricedOk() ? rcBurnables().length > 0 : rcBurnCands().length > 0);
const rcEmptiesMine = () => (rcMine() ? rcList().filter(rcEmpty) : []);
const rcBack = (a) => (a.native ? a.lamports : a.rentLamports); // closing wrapped SOL also unwraps its balance
const rcPicked = () => rcList().filter((a) => state.rc.sel.has(a.address) || (state.rc.burnAck && state.rc.burnSel.has(a.address)));
const rcTotal = () => rcPicked().reduce((s, a) => s + rcBack(a), 0);
const rcLabel = (a) => (looksSpam(a) ? short(a.mint) : a.symbol || short(a.mint));
const pad2 = (i) => String(i + 1).padStart(2, "0");
const lamSum = (list) => list.reduce((s, a) => s + a.rentLamports, 0);

function normAccount(a) {
  if (!a || typeof a.address !== "string" || !B58RE.test(a.address) || typeof a.mint !== "string" || !B58RE.test(a.mint)) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const str = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);
  return {
    address: a.address, mint: a.mint, program: a.program === "token-2022" ? "token-2022" : "token",
    amount: typeof a.amount === "string" && /^\d{1,30}$/.test(a.amount) ? a.amount : "0", uiAmount: num(a.uiAmount),
    frozen: !!a.frozen, native: !!a.native, rentLamports: num(a.rentLamports), lamports: num(a.lamports),
    closable: !!a.closable, burnable: !!a.burnable, burnCandidate: !!a.burnCandidate, reason: str(a.reason, 80), withheld: !!a.withheld,
    // the server's classifier says NFT (or SFT, edition, pNFT); never burned, and never listed while it holds one
    nft: a.nft === true, nftKind: str(a.nftKind, 16), nftUnsure: a.nft === true && a.nftUnsure === true, tokenIfPriced: a.nft === true && a.tokenIfPriced === true,
    symbol: str(a.symbol, 32), name: str(a.name, 64), verified: !!a.verified,
    usd: typeof a.usd === "number" && Number.isFinite(a.usd) ? a.usd : null,
  };
}

// RPC only, unless `prices`: then the server also prices the accounts that still hold something (Jupiter), which
// only the burn section needs. The empty-pockets line and card, the cleanup list and the post-run refresh never ask.
async function loadAccounts({ silent = false, prices = false } = {}) {
  if (!state.account) return;
  const rc = state.rc, addr = state.account.address, seq = ++rc.seq;
  if (prices) { rc.pricing = true; rc.pricingError = null; rc.built = null; renderCleanup(); }
  if (!silent) {
    rc.loading = true; rc.error = null;
    if (rc.owner !== addr) rc.accounts = null;
    if (!rc.accounts) setPose(sceneMascot("cleanup"), 12, { mode: "wiggle" });
    renderCleanup(); renderBar();
  }
  let res;
  try {
    res = await api("/api/accounts?owner=" + encodeURIComponent(addr) + (prices ? "&prices=1" : ""));
    if (!Array.isArray(res?.accounts)) throw new ApiError("Unexpected response from the server.", 500);
  } catch (e) {
    if (seq !== rc.seq || state.account?.address !== addr) return;
    rc.loading = false;
    if (rc.pricing) { rc.pricing = false; rc.built = null; }
    if (prices) { rc.pricingError = e.message; if (e.status === 429) startCooldown(30); }
    // a failed background read keeps whatever is on screen; only a visible load shows the error
    if (!silent) { rc.error = e.message; if (e.status === 429) startCooldown(30); setPose(sceneMascot("cleanup"), 4); }
    renderCleanup(); renderRentCard(); renderBar();
    return;
  }
  if (seq !== rc.seq || state.account?.address !== addr) return;
  const first = rc.owner !== addr || !rc.accounts;
  rc.loading = false; rc.error = null; rc.owner = addr; rc.at = Date.now();
  rc.priced = !!res.priced; rc.priceError = !!res.priceError; rc.pricing = false; rc.pricingError = null;
  // the biggest rent first (Token-2022 accounts hold a little more), then by name
  rc.accounts = res.accounts.map(normAccount).filter(Boolean)
    .sort((a, b) => (b.rentLamports - a.rentLamports) || (a.symbol || "~").localeCompare(b.symbol || "~"));
  const by = new Map(rc.accounts.map((a) => [a.address, a]));
  if (rc.pendingSel) {
    // "try again" after a run: exactly the accounts that didn't close, if they still can
    rc.sel = new Set([...rc.pendingSel].filter((x) => by.get(x)?.closable));
    rc.burnSel.clear(); rc.burnAck = false; rc.pendingSel = null; rc.resetSel = false;
  } else if (first || rc.resetSel) {
    // every empty account is picked, up to one run's worth; wrapped SOL and burns are always picked by hand
    rc.sel = new Set(rc.accounts.filter(rcEmpty).slice(0, RC_MAX).map((a) => a.address));
    rc.burnSel.clear(); rc.burnAck = false; rc.resetSel = false;
  } else {
    rc.sel = new Set([...rc.sel].filter((x) => by.get(x)?.closable));
    rc.burnSel = new Set([...rc.burnSel].filter((x) => by.get(x)?.burnable));
  }
  rcBackfillNames();
  if (state.scene === "cleanup" && !rc.plan && !rc.building) setPose(sceneMascot("cleanup"), rcHasWork() ? 2 : 13);
  renderCleanup(); renderRentCard(); renderResultReclaim(); renderBar();
  if (state.scene === "pockets" && !state.loading && !state.loadError && !state.rows.some((r) => r.usd != null && !isBurnRow(r))) renderPockets();
}
const rcLoadPrices = () => { if (!state.busy && !state.rc.pricing) loadAccounts({ silent: true, prices: true }); };

// Jupiter doesn't know every token. Names read on-chain for the cleanup fill the gaps in the pockets list (the
// unpriced rows), still as untrusted text, still unverified.
function rcBackfillNames() {
  if (!rcMine() || !state.rows.length) return;
  const by = new Map(rcList().map((a) => [a.mint, a]));
  let changed = false;
  for (const r of state.rows) {
    const a = by.get(r.mint);
    if (!r.symbol && a?.symbol) { r.symbol = a.symbol; r.name = r.name || a.name; changed = true; }
  }
  if (changed && state.scene === "pockets") renderPocketsMeta();
  // a collectible the pockets now know as a priced 0-decimal coin moves from "left alone" to "holds tokens"
  if (state.scene === "cleanup" && !state.busy && state.rc.built && rcList().some((a) => a.tokenIfPriced && a.amount !== "0")) { state.rc.built = null; renderCleanup(); }
}

/* the empty-pockets line and card in the pockets scene, and the offer on the result */
function renderRentCard() {
  const e = rcEmptiesMine(), lam = lamSum(e), dollars = solUsd(lam);
  // The line under the title is how the offer gets seen: the card sits at the end of the aside (so nothing the user
  // may be tapping moves when it appears), which is below the fold more often than not. The account read starts
  // together with the holdings read, so the line is usually there before the list is.
  const line = $("#pkRentLine");
  const listShown = !state.loading && !state.loadError && state.rows.some((r) => r.usd != null && !isBurnRow(r));
  line.hidden = !e.length || !listShown;
  if (!line.hidden) fill(line, h("button", { class: "btn-text sm rent-link", type: "button", disabled: !!state.busy, onclick: () => openCleanup() },
    icon("spark", "i i-sm"), h("span", {}, `Also: ${plural(e.length, "empty account")} ${e.length === 1 ? "holds" : "hold"} ${solApprox(lam)} SOL of rent`), h("span", { class: "m-hide" }, " · reclaim"), icon("arrow", "i i-sm")));
  const card = $("#rentCard"); if (!card) return;
  card.hidden = !e.length || state.loading || !!state.loadError;
  if (card.hidden) return;
  fill(card,
    h("div", { class: "rent-txt" },
      h("p", { class: "overline" }, "empty pockets"),
      h("p", { class: "rent-line" }, h("b", {}, plural(e.length, "empty account")), ` holding ${solApprox(lam)} SOL of rent${dollars ? ` (≈ ${dollars})` : ""}. No fee to get it back.`)),
    h("button", { class: "btn-ghost sm", type: "button", disabled: !!state.busy, onclick: () => openCleanup() }, "reclaim", icon("arrow", "i i-sm")));
}
function renderResultReclaim() {
  const slot = $("#resRc"), r = state.run;
  if (!slot || !r?.done) return;
  const e = rcEmptiesMine(), lam = lamSum(e);
  // one action per viewport: after a partial cleanup the bar's "try again" already covers the accounts still open
  const failed = r.kind === "reclaim" && r.items.some((i) => i.status !== "confirmed");
  fill(slot, e.length > 0 && !failed && h("button", { class: "btn-ghost sm", type: "button", onclick: () => { if (!state.busy) openCleanup(); } },
    r.kind === "reclaim" ? `clean up ${plural(e.length, "more account")} · ${solApprox(lam)} SOL` : `reclaim ${solApprox(lam)} SOL of rent`, icon("arrow", "i i-sm")));
}

function openCleanup({ select = null } = {}) {
  if (state.busy || !state.account) return;
  closeAllPops();
  const rc = state.rc;
  rc.plan = null; rc.notice = null; rc.building = null;
  // where "back" goes and what it says: the pockets only when that's where the user came from
  rc.from = state.scene === "cleanup" ? rc.from : state.scene;
  if (select) rc.pendingSel = new Set(select);
  const stale = !rcMine() || !rc.accounts || !!select || Date.now() - rc.at > 15_000;
  go("cleanup").then(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    if (stale) loadAccounts(); else { setPose(sceneMascot("cleanup"), 2); renderCleanup(); renderBar(); }
  });
}
function leaveCleanup() {
  if (state.busy) return;
  state.rc.plan = null;
  go("pockets", { back: true }).then(() => { if (state.rowsFor !== state.account?.address && !state.loading) loadHoldings(); });
}
function rcBackToList() {
  if (state.busy) return;
  state.rc.plan = null; state.rc.notice = null;
  renderCleanup(); renderBar();
  setPose(sceneMascot("cleanup"), 2);
}
$("#rcBack").addEventListener("click", () => {
  if (state.busy === "building" && state.rc.building) return rcCancelBuild();
  if (state.busy) return;
  if (state.rc.plan) return rcBackToList();
  leaveCleanup();
});

/* ---- rendering ---- */
function renderCleanup() {
  if (state.scene !== "cleanup") return;
  const rc = state.rc;
  $("#rcBack").lastChild.textContent = rc.building ? "cancel and go back" : rc.plan ? "back to the list" : rc.from === "pockets" ? "back to the pockets" : "to your dust";
  $("#rcOver").textContent = rc.plan || rc.building ? "scene 02 · the sweep" : "scene 01 · the cleanup";
  const note = $("#rcNotice");
  note.hidden = !rc.notice || !!rc.building;
  if (rc.notice) fill(note, icon("info"), h("span", {}, rc.notice));
  renderSlate();
  const quiet = !rc.plan && !rc.building && !rc.loading && !rc.error && rc.accounts && !rcHasWork();
  // one mascot per viewport: the set piece replaces the cameo in the empty and error states
  sceneMascot("cleanup").hidden = !!quiet || (!!rc.error && !rc.accounts);
  if (rc.building) return drawRcBuilding();
  if (rc.plan) return drawRcReview();
  drawRcPick();
}

// what can't be closed, with the reason for each; shown in the list and in the "nothing to close" state alike
function rcBlockedBox(blocked) {
  return blocked.length > 0 && h("details", { class: "hidden-list rc-blocked" },
    h("summary", {}, h("span", {}, `${plural(blocked.length, "account")} can’t be closed`), icon("chev", "i i-sm")),
    h("div", { class: "hidden-rows" }, blocked.map((a) => h("div", { class: "hrow" },
      h("div", { style: "min-width:0" }, h("span", { class: "sym" }, rcLabel(a)), h("span", { class: "who-sub" }, rcBlockedWhy(a))),
      h("span", { class: "who-sub mono" }, short(a.address))))));
}

function drawRcPick() {
  const rc = state.rc, main = $("#rcMain"), aside = $("#rcAside"), hero = $("#rcHero");
  if (!rc.accounts) {
    hero.hidden = true; rc.built = null; rc.inputs.clear(); main.dataset.view = "";
    if (rc.error) {
      $("#rc-title").textContent = "couldn’t read the accounts";
      $("#rcFacts").textContent = `${rc.error} Nothing was signed or sent.`;
      fill(main, h("div", { class: "state-card" }, stateStill(4, "the lining’s stuck", "Give it a moment, then try again from the bar below.")));
    } else {
      $("#rc-title").textContent = "checkin’ the lining…";
      $("#rcFacts").textContent = "Reading every token account, empty ones too. Nothing gets signed.";
      fill(main, h("div", { class: "rows" }, Array.from({ length: 5 }, (_, i) => h("div", { class: "row skel", "aria-hidden": "true" },
        h("span", {}), h("span", { class: "sk", style: "width:22px;height:22px;border-radius:7px" }), h("span", { class: "sk", style: "width:36px;height:36px;border-radius:50%" }),
        h("span", { style: "display:grid;gap:7px" }, h("span", { class: "sk", style: `width:${70 + ((i * 37) % 60)}px` }), h("span", { class: "sk", style: `width:${120 + ((i * 53) % 70)}px;height:9px` })),
        h("span", { class: "sk", style: "width:52px" })))));
    }
    aside.replaceChildren(rcHowCard());
    return;
  }
  const allEmpty = rcList().filter(rcEmpty), empties = allEmpty.filter(rcTokEmpty), nftEmpties = allEmpty.filter(rcNftEmpty);
  const wsol = rcList().filter(rcWsol), burnCands = rcBurnCands(), alone = rcAloneCounts(), nftHeld = alone.nfts + alone.coll;
  // what the empty-NFT group is called: by the kinds in it, never "tokens"
  const emptyNfts = nftEmpties.filter((a) => isNftKind(a.nftKind)).length, emptyColl = nftEmpties.length - emptyNfts;
  const emptyWhat = emptyColl ? (emptyNfts ? "NFTs and collectibles" : "collectibles") : "NFTs";
  // Nothing to close, only accounts that still hold something: burning is the only thing left to offer, so the
  // prices are worth reading right away (and if none of it is under $1, this becomes "nothing to close").
  if (!rcCandidates().length && burnCands.length && !rc.priced && !rc.pricing && !rc.pricingError && !state.busy) { rc.burnOpen = true; rcLoadPrices(); }
  const blocked = rcList().filter(rcBlocked), holding = rcHolding(), lamAll = lamSum(allEmpty);
  if (!rcHasWork()) {
    hero.hidden = true; rc.built = null; rc.inputs.clear(); main.dataset.view = "";
    $("#rc-title").textContent = "no lint here";
    const holds = holding.length === 1 ? "holds" : "hold";
    $("#rcFacts").textContent = blocked.length
      ? `${plural(blocked.length, "account")} can’t be closed by this wallet (the reasons are below)${holding.length ? `, and ${plural(holding.length, "other")} still ${holds} something worth keeping or selling` : ""}.`
      : holding.length ? "Every token account in this wallet still holds something worth keeping or selling, so there’s nothing to close."
      : nftHeld ? `Every account in this wallet holds ${alone.coll ? (alone.nfts ? "an NFT or a collectible" : "a collectible") : "an NFT"}, and Spacedust leaves those alone, so there’s nothing to close.`
      : alone.unchecked ? "Every account in this wallet still holds something, and some couldn’t be checked just now, so there’s nothing to close."
      : "This wallet has no token accounts besides SOL itself, so there’s nothing to close.";
    // the bar carries "back to your dust"; the card only offers what the bar doesn't
    fill(main, h("div", { class: "state-card" }, stateStill(13, "not a speck of lint", blocked.length ? "Dusty found accounts, but this wallet isn’t allowed to close them." : "Dusty turned out every pocket. Empty accounts show up here after you sell or send tokens."),
      h("div", { class: "state-actions" }, h("button", { class: "btn-text sm", type: "button", onclick: () => loadAccounts() }, icon("refresh", "i i-sm"), "check again"))),
      rcBlockedBox(blocked), rcLeftAlone(alone));
    aside.replaceChildren();
    return;
  }
  hero.hidden = false; hero.classList.remove("compact", "stale");
  $("#rc-title").textContent = "empty pockets";
  const dollars = solUsd(lamAll);
  $("#rcFacts").textContent = allEmpty.length
    ? `${plural(allEmpty.length, "empty account")}${!nftEmpties.length ? "" : nftEmpties.length === allEmpty.length ? ` (${allEmpty.length === 1 ? "it’s" : "all"} left over from ${emptyWhat})` : ` (${nftEmpties.length.toLocaleString("en-US")} of them left over from ${emptyWhat})`} holding about ${solAmt(lamAll)} SOL of rent${dollars ? ` (≈ ${dollars})` : ""}. Closing an account sends its rent back to your wallet. No fee.${allEmpty.length > RC_MAX ? ` Up to ${RC_MAX} per run, so the first ${RC_MAX} are picked; run it again for the rest.` : ""}`
    : `No empty token accounts right now.${wsol.length ? " Wrapped SOL can be unwrapped below." : ""}${burnCands.length ? " Leftover dust under $1 can be burned and closed below, if you choose to." : ""}`;
  // Rows are built once per read and patched afterwards, so ticking a box never moves focus or scroll. The review
  // and the build progress replace #rcMain, so coming back from them always rebuilds.
  if (rc.built !== rc.accounts || main.dataset.view !== "pick") {
    const act = document.activeElement, focusAddr = act?.closest?.("#rcMain") ? act.dataset.addr || null : null;
    rc.inputs.clear();
    const all = h("input", { type: "checkbox", class: "cb-input", id: "rcAll" });
    all.addEventListener("change", () => {
      if (state.busy) return;
      if (all.checked) { const room = RC_MAX - (rc.burnAck ? rc.burnSel.size : 0) - wsol.filter((a) => rc.sel.has(a.address)).length; rc.sel = new Set([...wsol.filter((a) => rc.sel.has(a.address)).map((a) => a.address), ...rcList().filter(rcEmpty).slice(0, Math.max(0, room)).map((a) => a.address)]); }
      else for (const a of allEmpty) rc.sel.delete(a.address);
      syncCleanup();
    });
    const burnAck = h("input", { type: "checkbox", id: "rcBurnAck" });
    burnAck.addEventListener("change", () => {
      if (state.busy) { burnAck.checked = rc.burnAck; return; }
      rc.burnAck = burnAck.checked;
      if (!rc.burnAck) rc.burnSel.clear();
      syncCleanup();
    });
    // A wallet with 1,300 empty accounts gets the first rows and a "show more", so what comes after the list (the
    // burn section, what can't be closed) stays within reach. Unshown accounts can still be picked: "select all"
    // and the default pick work on the whole list.
    const list = h("div", { class: "rows rc-rows", id: "rcList", role: "group", "aria-label": "Empty token accounts" });
    const fillList = () => {
      const have = list.children.length;
      list.append(...empties.slice(have, Math.max(have, rc.showN)).map((a, j) => rcRow(a, have + j, "close")));
    };
    fillList();
    const more = h("button", { class: "btn-ghost sm rc-more", type: "button", id: "rcMore", onclick: () => { if (state.busy) return; rc.showN += 200; fillList(); syncCleanup({ bar: false }); } });
    // empty accounts left over from NFTs: their own group, paged the same way (a collector's wallet can have hundreds)
    const nftList = h("div", { class: "rows rc-rows", id: "rcNftList", role: "group", "aria-label": `Empty ${emptyWhat === "NFTs" ? "NFT" : emptyWhat === "collectibles" ? "collectible" : "NFT and collectible"} accounts` });
    const fillNft = () => {
      const have = nftList.children.length;
      nftList.append(...nftEmpties.slice(have, Math.max(have, rc.nftShowN)).map((a, j) => rcRow(a, have + j, "close")));
    };
    fillNft();
    const nftMore = h("button", { class: "btn-ghost sm rc-more", type: "button", id: "rcNftMore", onclick: () => { if (state.busy) return; rc.nftShowN += 200; fillNft(); syncCleanup({ bar: false }); } });
    const big = holding.filter((a) => a.burnCandidate).length, kept = holding.length - big;
    fill(main,
      wsol.length > 0 && h("div", { class: "rc-wsol" },
        h("div", { class: "overline list-label" }, h("span", {}, "wrapped SOL · picked by hand"), h("span", { class: "tl-col" }, "back")),
        h("div", { class: "rows rc-rows", role: "group", "aria-label": "Wrapped SOL" }, wsol.map((a, i) => rcRow(a, i, "close")))),
      allEmpty.length > 0 && h("div", { class: "tracklist rc-tracklist" },
        h("div", { class: "tl-head" },
          h("label", { class: "tl-all" }, all, h("span", { class: "cb", "aria-hidden": "true" }, icon("spark", "i"), h("i", { class: "dash" })), h("span", { id: "rcAllLabel" })),
          h("button", { class: "btn-text sm", type: "button", onclick: () => { if (state.busy) return; for (const a of allEmpty) rc.sel.delete(a.address); syncCleanup(); } }, "clear"),
          h("span", { class: "tl-col" }, "rent back")),
        empties.length > 0 && [list, more],
        nftEmpties.length > 0 && h("div", { class: "rc-nft" },
          h("div", { class: "overline list-label" }, h("span", {}, `empty ${emptyWhat === "NFTs" ? "NFT" : emptyWhat === "collectibles" ? "collectible" : "NFT & collectible"} accounts · ${nftEmpties.length.toLocaleString("en-US")}`)),
          h("p", { class: "hint" }, `The ${emptyWhat === "NFTs" ? "NFT" : emptyWhat === "collectibles" ? "collectible" : "NFT or collectible"} already left this wallet; closing returns the rent. Nothing else is touched.`),
          nftList, nftMore)),
      burnCands.length > 0 && rcBurnBox(burnAck),
      rcBlockedBox(blocked),
      holding.length > 0 && h("p", { class: "hint rc-holding" }, [
        `${plural(holding.length, "other account")} still ${holding.length === 1 ? "holds" : "hold"} tokens the cleanup leaves alone.`,
        big && `${big === holding.length ? (big === 1 ? "It’s" : "They’re") : `${big} ${big === 1 ? "is" : "are"}`} worth $1 or more: sell ${big === 1 ? "it" : "them"} in the pockets, which closes the account too.`,
        kept && "The burn token and tokens with no decimals are never burned here."].filter(Boolean).join(" ")),
      rcLeftAlone(alone));
    rc.built = rc.accounts; main.dataset.view = "pick";
    if (focusAddr) rc.inputs.get(focusAddr)?.focus({ preventScroll: true });
    aside.replaceChildren(rcHowCard());
  }
  syncCleanup({ bar: false });
}
// accounts that still hold an NFT or collectible: not listed, not counted as tokens, just one quiet line
function rcLeftAlone({ nfts, coll, unchecked }) {
  const n = nfts + coll;
  return (n > 0 || unchecked > 0) && h("p", { class: "hint left-alone" }, icon("info", "i i-sm"), h("span", {},
    n ? `${leftAlonePhrase(nfts, coll)} in this wallet ${n === 1 ? "is" : "are"} left alone. Spacedust never closes, sells or burns an account that holds one.` : "",
    unchecked ? [n ? " " : "", `${plural(unchecked, "account")} couldn’t be checked just now, so ${unchecked === 1 ? "it’s" : "they’re"} left alone too. `,
      h("button", { class: "btn-text sm", type: "button", onclick: () => loadAccounts() }, "check again")] : ""));
}
function rcBurnBox(burnAck) {
  const rc = state.rc, priced = rcBurnPriced(), unpriced = rcBurnUnpriced();
  const selectAll = h("button", { class: "btn-text sm", type: "button", id: "rcBurnAll", onclick: () => {
    if (state.busy || !rc.burnAck) return;
    // "select all" never includes the unpriced ones: those are picked one by one
    const keep = unpriced.filter((a) => rc.burnSel.has(a.address)).map((a) => a.address);
    const room = RC_MAX - rc.sel.size - keep.length;
    rc.burnSel = new Set([...keep, ...priced.slice(0, Math.max(0, room)).map((a) => a.address)]);
    syncCleanup();
  } }, "select all under $1");
  const clear = h("button", { class: "btn-text sm", type: "button", onclick: () => { if (state.busy) return; rc.burnSel.clear(); syncCleanup(); } }, "clear");
  const body = !rcPricedOk()
    ? h("p", { class: "hint rc-pricing", role: "status" }, rc.pricing ? [h("span", { class: "spin" }), "Checking what these are worth…"]
      : rc.pricingError || rc.priceError ? ["Prices couldn’t be checked just now, so nothing is offered for burning. ", h("button", { class: "btn-text sm", type: "button", "data-cd": "try again", onclick: rcLoadPrices }, "try again")]
      : "Open this section to check what they’re worth.")
    : !priced.length && !unpriced.length ? h("p", { class: "hint rc-pricing" }, "None of them is worth less than $1 right now, so there’s nothing to burn.")
    : [priced.length > 0 && [
        h("div", { class: "rc-burn-head" }, h("p", { class: "overline" }, `under $1 · ${priced.length}`), h("div", { class: "rc-burn-tools" }, selectAll, clear)),
        h("div", { class: "rows rc-rows", role: "group", "aria-label": "Dust worth less than $1" }, priced.map((a, i) => rcRow(a, i, "burn")))],
      unpriced.length > 0 && [
        h("div", { class: "rc-burn-head" }, h("p", { class: "overline pink" }, `no price · value unknown · ${unpriced.length}`),
          h("p", { class: "hint" }, "Jupiter has no price for these, so there’s no telling what they’re worth. Tick one only if you’re sure it’s junk."),
          !priced.length && h("div", { class: "rc-burn-tools" }, clear)),
        h("div", { class: "rows rc-rows", role: "group", "aria-label": "Tokens with no price, value unknown" }, unpriced.map((a, i) => rcRow(a, priced.length + i, "burn")))]];
  const box = h("details", { class: "hidden-list rc-burn", id: "rcBurnBox" },
    h("summary", {}, icon("flame", "i i-sm pinkt rc-flame"), h("span", { id: "rcBurnSum" }), icon("chev", "i i-sm")),
    h("div", { class: "hidden-rows" },
      h("div", { class: "warn-card rc-warn", role: "group", "aria-label": "Burning is irreversible" },
        h("p", { class: "warn-title" }, icon("warn"), "burning is forever"),
        h("p", {}, "Burning destroys these tokens, then closes the account for its rent. It’s for spam and dead tokens. Nothing is sold, and it can’t be undone. Anything you’d rather turn into SOL, sell in the pockets instead."),
        h("label", { class: "toggle sm" }, burnAck, h("span", { class: "tg", "aria-hidden": "true" }), h("span", {}, "I understand: burned tokens are gone for good"))),
      body));
  box.open = rc.burnOpen;
  // opening the section is what asks for prices (the only Jupiter call the cleanup makes before a build)
  box.addEventListener("toggle", () => { rc.burnOpen = box.open; if (box.open && !rc.priced && !rc.pricing && !rc.pricingError) rcLoadPrices(); });
  return box;
}
function rcBlockedWhy(a) {
  // an empty NFT account that can't be closed is still an NFT account, never "the token's"
  const what = !a.nft || a.nftUnsure ? null : isNftKind(a.nftKind) ? "NFT" : "collectible";
  if (what && (a.frozen || a.reason === "frozen")) return `Empty ${what} account, frozen by its collection’s authority, so it can’t be closed.`;
  if (what && a.reason === "close authority is someone else") return `Empty ${what} account; another address holds the right to close it, so this wallet can’t.`;
  if (a.frozen || a.reason === "frozen") return "Frozen by the token’s issuer, so it can’t be closed.";
  if (a.reason === "close authority is someone else") return "Another address holds the right to close it, so this wallet can’t.";
  return a.reason ? a.reason.charAt(0).toUpperCase() + a.reason.slice(1) + "." : "Can’t be closed right now.";
}
function rcRow(a, i, kind) {
  const rc = state.rc, spam = looksSpam(a), burn = kind === "burn", back = solAmt(rcBack(a));
  const input = h("input", { type: "checkbox", class: "cb-input", "data-addr": a.address, "data-kind": kind,
    "aria-label": burn ? `Burn and close ${rcLabel(a)}, ${a.usd == null ? "no price, value unknown" : `worth ${usdP(a.usd)}`}, ${back} SOL back` : `Close ${a.native ? "wrapped SOL" : a.nft && !a.nftUnsure ? `the empty ${isNftKind(a.nftKind) ? "NFT" : "collectible"} account of ${rcLabel(a)}` : rcLabel(a)}, ${back} SOL back` });
  rc.inputs.set(a.address, input);
  // flags the user can't act on live in the sub-line, so the name keeps the top line to itself on a phone
  const t22 = a.program === "token-2022" ? " · token-2022" : "";
  const fees = a.withheld ? " · withheld fees go to the mint first" : "";
  const sub = burn
    ? [`${amt(a.uiAmount)} left · `, a.usd == null ? h("span", { class: "pinkt" }, "value unknown") : "could be sold instead", t22]
    : a.native ? `unwraps ${solAmt(a.lamports - a.rentLamports)} SOL + rent`
    : a.nft && !a.nftUnsure ? [`empty · ${isNftKind(a.nftKind) ? "NFT" : "collectible"} already gone`, a.symbol ? [" · ", h("span", { class: "mono" }, short(a.mint))] : "", t22, fees]
    : !a.symbol && !a.name ? ["no name on-chain", t22, fees]
    : [!spam && a.name ? h("span", { class: "nm" }, a.name + " · ") : "", h("span", { class: "mono" }, short(a.mint)), t22, fees];
  const name = spam ? [h("span", { class: "m-hide" }, "name hidden: likely spam"), h("span", { class: "m-show" }, "likely spam")] : a.native ? "wrapped SOL" : rcLabel(a);
  const el = h("label", { class: "row rc-row" + (burn ? " burn" : "") },
    h("span", { class: "tno" }, pad2(i)), input,
    h("span", { class: "cb", "aria-hidden": "true" }, icon("spark"), h("i", { class: "dash" })),
    tokIcon(a),
    h("span", { class: "who" }, h("span", { class: "who-top" }, h("span", { class: "sym" }, name)), h("span", { class: "who-sub" }, sub)),
    // a burn row leads with what's being destroyed; the rent coming back is the small print
    burn ? h("span", { class: "worth" }, h("b", { class: a.usd == null ? "pinkt" : null }, a.usd == null ? "no price" : usdP(a.usd)), h("span", {}, `+${back} SOL`))
      : h("span", { class: "worth" }, h("b", {}, `+${back}`), h("span", {}, "SOL")));
  input.addEventListener("change", () => {
    const set = burn ? rc.burnSel : rc.sel;
    if (state.busy || (burn && !rc.burnAck)) { input.checked = set.has(a.address); return; }
    if (input.checked && rcPicked().length >= RC_MAX) { input.checked = false; toast({ title: `${RC_MAX} per run`, body: "That’s as many as one wallet prompt carries. Run the cleanup again for the rest." }); return; }
    if (input.checked) set.add(a.address); else set.delete(a.address);
    syncCleanup();
    if (input.checked && !burn) react(9, 2, 800);
  });
  return el;
}
function syncCleanup({ bar = true } = {}) {
  const rc = state.rc, busy = !!state.busy, picked = rcPicked(), full = picked.length >= RC_MAX;
  for (const [addr, inp] of rc.inputs) {
    const burn = inp.dataset.kind === "burn", on = burn ? rc.burnAck && rc.burnSel.has(addr) : rc.sel.has(addr);
    inp.checked = on;
    inp.disabled = busy || (burn && !rc.burnAck) || (!on && full);
    inp.closest(".row")?.classList.toggle("off", inp.disabled && !on);
  }
  const em = rcList().filter(rcEmpty);
  const all = $("#rcAll");
  if (all) {
    const on = em.filter((a) => rc.sel.has(a.address)).length, cap = Math.min(em.length, RC_MAX), n = em.length.toLocaleString("en-US");
    all.checked = cap > 0 && on >= cap; all.indeterminate = on > 0 && on < cap; all.disabled = busy || !em.length;
    fill($("#rcAllLabel"), em.length > RC_MAX ? [h("span", { class: "m-hide" }, "select "), `${RC_MAX} of ${n}`] : `select all empty (${n})`);
  }
  for (const [more, list, group] of [[$("#rcMore"), $("#rcList"), em.filter(rcTokEmpty)], [$("#rcNftMore"), $("#rcNftList"), em.filter(rcNftEmpty)]]) {
    if (!more || !list) continue;
    const shownN = list.children.length, left = group.length - shownN, pickedHidden = group.slice(shownN).filter((a) => rc.sel.has(a.address)).length;
    more.hidden = left <= 0; more.disabled = busy;
    more.textContent = `show ${Math.min(200, left).toLocaleString("en-US")} more · ${plural(left, "account")} not shown${pickedHidden ? `, ${pickedHidden.toLocaleString("en-US")} of them picked` : ""}`;
  }
  const ack = $("#rcBurnAck");
  if (ack) { ack.checked = rc.burnAck; ack.disabled = busy || rc.priceError; }
  const bAll = $("#rcBurnAll"); if (bAll) bAll.disabled = busy || !rc.burnAck;
  const bs = $("#rcBurnSum");
  if (bs) {
    const b = rcBurnables(), on = rc.burnAck ? b.filter((a) => rc.burnSel.has(a.address)).length : 0;
    bs.textContent = !rcPricedOk()
      ? `burn & close leftover dust (under $1) · ${plural(rcBurnCands().length, "account")} with a balance`
      : `burn & close leftover dust (under $1) · ${on ? `${on} of ${b.length} picked` : b.length ? plural(b.length, "account") : "none under $1"}${b.length ? ` · +${solAmt(lamSum(b))} SOL` : ""}`;
  }
  rcHeroPick(picked);
  if (bar) renderBar();
}
function rcHeroPick(picked = rcPicked()) {
  const rc = state.rc, burns = picked.filter((a) => rc.burnSel.has(a.address)).length, wsolN = picked.filter((a) => a.native).length;
  const back = picked.reduce((s, a) => s + rcBack(a), 0), dollars = solUsd(back);
  fill($("#rcHero"),
    h("div", { class: "ch-block" }, h("p", { class: "overline" }, "closing"), h("p", { class: "ch-big" }, String(picked.length), h("small", {}, picked.length === 1 ? "account" : "accounts")),
      h("p", { class: "ch-sub" }, burns ? `${burns} burned first, for good` : wsolN ? "incl. wrapped SOL" : `of ${plural(rcList().filter(rcEmpty).length, "empty account")}`)),
    svgArrow(),
    h("div", { class: "ch-block ch-out" }, h("p", { class: "overline" }, "you get back"), h("p", { class: "ch-big" }, solApprox(back), h("small", {}, "SOL")),
      h("p", { class: "ch-sub" }, picked.length ? ["rent back", h("span", { class: "m-hide" }, " to your wallet"), " · no fee"] : "pick accounts to see the total"),
      picked.length > 0 && dollars && h("p", { class: "ch-sub ch-usd" }, `≈ ${dollars} at today’s SOL price`)));
}
function rcHowCard() {
  return h("div", { class: "card" }, h("p", { class: "overline" }, "how the cleanup works"), h("ul", { class: "ask-list" },
    h("li", {}, icon("spark"), h("span", {}, "Every token account holds about ", h("b", {}, "0.002 SOL of rent"), ". Closing an empty one sends it back to your wallet.")),
    h("li", {}, icon("spark"), h("span", {}, h("b", {}, "No fee. "), "Spacedust adds nothing to these transactions. You pay only the network fee, a fraction of a cent each.")),
    h("li", {}, icon("wallet"), h("span", {}, "About 25 closes fit in one transaction, and your wallet asks once for all of them.")),
    h("li", {}, icon("spark"), h("span", {}, "Nothing is lost: if a token comes back to this wallet later, a new account is opened for it then."))));
}

function drawRcBuilding() {
  const b = state.rc.building, hero = $("#rcHero");
  state.rc.built = null; $("#rcMain").dataset.view = "building"; // this replaces the list; going back rebuilds it
  $("#rc-title").textContent = "baggin’ the lint…";
  $("#rcFacts").textContent = "Re-reading every account, packing them into transactions and simulating each one. Nothing gets signed.";
  hero.hidden = false; hero.classList.add("compact"); hero.classList.remove("stale");
  fill(hero, h("p", { class: "ch-line" }, h("b", {}, plural(b.n, "account")), icon("arrow", "i"), h("b", { class: "ch-line-out" }, `${solApprox(b.back)} SOL`), h("span", {}, "back to your wallet")));
  fill($("#rcMain"),
    h("div", { class: "progress" }, h("div", { class: "progress-track" }, h("span", { class: "progress-fill", style: "width:38%" })), h("p", { class: "progress-label" }, `packing and simulating ${plural(b.n, "close")}…`)),
    h("ol", { class: "tx-list" }, Array.from({ length: Math.min(4, Math.max(1, Math.ceil(b.n / 25))) }, (_, i) => h("li", { class: "tx" },
      h("span", { class: "tno" }, pad2(i)), h("span", { class: "sk", style: "width:36px;height:36px;border-radius:50%" }),
      h("span", { style: "display:grid;gap:7px" }, h("span", { class: "sk", style: "width:90px" }), h("span", { class: "sk", style: "width:160px;height:9px" })),
      h("span", { class: "pill" }, h("span", { class: "spin" }), "checking")))));
  rc_aside(h("div", { class: "card" }, h("p", { class: "overline" }, "while you wait"), h("ul", { class: "ask-list" },
    h("li", {}, icon("spark"), h("span", {}, "Every account is re-read on the server. Nothing from this page is trusted.")),
    h("li", {}, icon("spark"), h("span", {}, "Every transaction is simulated before you see it.")),
    h("li", {}, icon("spark"), h("span", {}, "Accounts that can’t close are skipped, with the reason.")))));
}
const rc_aside = (...cards) => $("#rcAside").replaceChildren(...cards.filter(Boolean));

// named, non-spam accounts first: they're the ones that will show a picture rather than a letter
const rcIcoScore = (a) => (a.native ? 3 : !looksSpam(a) && a.symbol ? 2 : 0) + (Date.now() - (badImg.get(a.mint) ?? -Infinity) < 180_000 ? -2 : 0);
function rcTxLi(t, i, { right = null, note = null, gone = false, details = true } = {}) {
  const accts = t.accounts, burns = accts.filter((a) => a.action !== "close"), n = accts.length;
  const labels = accts.map(rcLabel);
  const names = labels.length > 4 ? `${labels.slice(0, 4).join(", ")} +${labels.length - 4} more` : labels.join(", ");
  return h("li", { class: "tx rc-tx" },
    h("span", { class: "tno" }, pad2(i)),
    h("span", { class: "ico-stack", "aria-hidden": "true" }, [...accts].sort((a, b) => rcIcoScore(b) - rcIcoScore(a)).slice(0, 2).map((a) => tokIcon(a)), n > 2 && h("span", { class: "ico-more" }, `+${n - 2}`)),
    h("div", { style: "min-width:0" },
      h("p", { class: "who-top" }, h("span", { class: "sym" }, burns.length ? `${plural(n - burns.length, "close")} · ${burns.length} burn${burns.length === 1 ? "" : "s"}` : plural(n, "close"))),
      h("p", { class: "tx-flow" }, h("span", {}, names), icon("arrow", "i"), h("b", { class: gone ? "gone" : null }, `+${solAmt(t.lamports)} SOL`), gone && h("span", { class: "gone-l" }, " · not received")),
      burns.length > 0 && h("p", { class: "tx-burn" }, icon("flame", "i"), `burns ${burns.map(rcLabel).join(", ")} for good`)),
    right || h("div", { class: "tx-right" }),
    details && h("details", {}, h("summary", {}, `${plural(n, "account")}`), h("ul", { class: "rc-accts" }, accts.map((a) => h("li", {},
      h("span", { class: "rc-a-name" }, rcLabel(a)), h("span", { class: "mono" }, short(a.address)),
      h("span", { class: a.action === "close" ? "" : "pinkt" }, a.action === "close" ? (a.native ? `unwrap +${solAmt(a.lamports)}` : `+${solAmt(a.lamports)}`) : `burn · +${solAmt(a.lamports)}`))))),
    note);
}
function drawRcReview() {
  const rc = state.rc, p = rc.plan, n = p.txs.length, hero = $("#rcHero");
  rc.built = null; $("#rcMain").dataset.view = "review"; // this replaces the list; "back to the list" rebuilds it
  const back = p.txs.reduce((s, t) => s + t.lamports, 0), accts = p.txs.reduce((s, t) => s + t.accounts.length, 0);
  const burns = p.txs.reduce((s, t) => s + t.accounts.filter((a) => a.action !== "close").length, 0), unwrap = p.txs.some((t) => t.accounts.some((a) => a.native));
  const fee = p.txs.reduce((s, t) => s + t.feeLamports, 0);
  $("#rc-title").textContent = n ? "review the sweep" : "nothing made the cut";
  $("#rcFacts").textContent = n
    ? `${plural(accts, "account")} in ${plural(n, "transaction")}. Your wallet will ask once${n > 1 ? ` for all ${n}` : ""}.${p.skipped.length ? ` Another ${p.skipped.length} ${p.skipped.length === 1 ? "was" : "were"} skipped (reasons below).` : ""}`
    : "None of these accounts could be closed right now. Nothing was built or signed. Reasons are below.";
  hero.classList.remove("compact");
  hero.hidden = !n;
  if (n) fill(hero,
    h("div", { class: "ch-block" }, h("p", { class: "overline" }, "closing"), h("p", { class: "ch-big" }, String(accts), h("small", {}, accts === 1 ? "account" : "accounts")), h("p", { class: "ch-sub" }, `${plural(n, "transaction")} · 1\u00a0wallet\u00a0prompt`)),
    svgArrow(),
    h("div", { class: "ch-block ch-out" }, h("p", { class: "overline" }, "you get back"), h("p", { class: "ch-big" }, `${solApprox(back)}`, h("small", {}, "SOL")),
      h("p", { class: "ch-sub" }, `${unwrap ? "rent plus unwrapped SOL" : "rent"} · no fee${burns ? ` · ${burns} burned` : ""}`),
      solUsd(back) && h("p", { class: "ch-sub ch-usd" }, `≈\u00a0${solUsd(back)} at today’s SOL price`)));
  const skipped = p.skipped.length > 0 && (() => {
    const groups = [];
    for (const s of p.skipped) { const g = groups.find((x) => x.reason === s.reason); if (g) g.items.push(s); else groups.push({ reason: s.reason, items: [s] }); }
    const nameOf = (s) => { const a = rcAcc(s.address); return a ? rcLabel(a) : short(s.address); };
    return h("div", { class: "skipped" }, h("p", { class: "overline" }, h("span", {}, `bonus tracks · skipped ${p.skipped.length}`)),
      groups.map((g, gi) => {
        const nm = g.items.map(nameOf);
        return h("div", { class: "skip-row" }, h("span", { class: "tno" }, pad2(n + gi)),
          h("div", { style: "min-width:0" }, h("span", { class: "skip-sym" }, nm.length > 6 ? `${nm.slice(0, 6).join(", ")} +${nm.length - 6} more` : nm.join(", ")),
            g.items.length > 1 && h("span", { class: "skip-n" }, ` · ${g.items.length} accounts`),
            h("p", { class: "skip-why" }, g.reason.charAt(0).toUpperCase() + g.reason.slice(1) + (/[.]$/.test(g.reason) ? "" : "."))));
      }));
  })();
  fill($("#rcMain"),
    h("div", { class: "overline list-label" }, h("span", {}, `tracklist · ${plural(n, "transaction")}`)),
    h("ol", { class: "tx-list" }, p.txs.map((t, i) => {
      const li = rcTxLi(t, i);
      if (!p._shown && !reduced()) li.animate([{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], { duration: 380, delay: Math.min(i, 14) * 35, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
      return li;
    })),
    skipped);
  p._shown = true;
  rc_aside(
    n > 0 && h("div", { class: "card ask-card" },
      h("p", { class: "overline" }, "what your wallet will ask"),
      h("h3", {}, `1 prompt · ${plural(n, "transaction")}`),
      h("ul", { class: "ask-list" },
        h("li", {}, icon("wallet"), h("span", {}, h("b", {}, `${state.wallet?.name || "Your wallet"} opens once`), " and asks you to approve ", h("b", {}, plural(n, "transaction")), `. ${n === 1 ? "It closes" : "Together they close"} ${plural(accts, "account")}.`)),
        h("li", {}, icon("arrow"), h("span", {}, "Coming in: ", h("b", {}, `${solApprox(back)} SOL`), unwrap ? ", rent plus your unwrapped SOL." : " of rent.")),
        burns > 0 && h("li", { class: "ask-warn" }, icon("flame", "i pink"), h("span", {}, h("b", {}, `${plural(burns, "token")} ${burns === 1 ? "leaves" : "leave"} for good. `), `${burns === 1 ? "It’s" : "They’re"} burned, not sold, and that can’t be undone.`)),
        // network fees are tiny (~0.000005 SOL each), so they get significant digits rather than four decimals
        h("li", {}, icon("bolt"), h("span", {}, `Network fee about ${(fee / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 2 })} SOL${n > 1 ? ` for all ${n}` : ""}, paid from your SOL balance.`)),
        h("li", {}, icon("spark"), h("span", {}, "Check the balance changes it shows. Spacedust never holds your funds or keys, and nothing is sent until you approve.")))),
    n > 0 && h("div", { class: "burn-card frame nofee-state" }, h("p", { class: "overline green" }, "no fee"),
      h("p", { class: "hint", style: "color:var(--lav-2)" }, "Spacedust adds nothing to the cleanup. The rent goes back to the wallet that paid it.")));
}

/* ---- the bottom bar ---- */
function renderCleanupBar(feeEl) {
  const rc = state.rc;
  // on the narrowest phones the bar hides the "≈ X SOL back" line, so the figure moves into this one there
  const noFee = (lam = 0) => feeEl.replaceChildren(h("span", { class: "greent" }, lam > 0 && h("span", { class: "xs-show" }, `${solApprox(lam)} SOL · `), "no fee",
    h("span", { class: "m-hide" }, " · the rent comes back to you"), h("span", { class: "m-show xs-hide" }, " · rent back")));
  if (rc.building) {
    $("#sumCount").textContent = "checking…"; $("#sumWorth").textContent = `${solApprox(rc.building.back)} SOL back`;
    feeEl.replaceChildren(h("span", {}, "nothing gets signed yet"));
    caption("baggin’ up the lint");
    return setCta("building…", { disabled: true, busy: true, alt: { label: "cancel", run: rcCancelBuild } });
  }
  if (rc.plan) {
    const n = rc.plan.txs.length;
    $("#sumCount").textContent = n ? plural(n, "transaction") : "nothing to send";
    const planBack = rc.plan.txs.reduce((s, t) => s + t.lamports, 0);
    $("#sumWorth").textContent = n ? `${solApprox(planBack)} SOL back` : "";
    if (n) noFee(planBack);
    if (state.busy === "signing") { caption("stampin’ a fresh blockhash…"); return setCta("preparing…", { disabled: true, busy: true }); }
    if (!n) { caption("nothing made the cut"); return setCta("back to the list", { action: rcBackToList }); }
    caption(rc.plan.burns ? "lint’s bagged. burns are final, your call" : "lint’s bagged. your call");
    return setCta(`approve ${n} in wallet`, { action: approveReclaim });
  }
  if (!rc.accounts) {
    if (rc.error) {
      $("#sumCount").textContent = "couldn’t load"; caption("the lining wouldn’t give");
      feeEl.replaceChildren(h("span", {}, "nothing was signed or sent"));
      const left = cooldownLeft();
      return left > 0 ? setCta(`try again in ${left}s`, { disabled: true }) : setCta("try again", { action: () => loadAccounts() });
    }
    $("#sumCount").textContent = "reading accounts…"; feeEl.replaceChildren(h("span", {}, "nothing gets signed"));
    caption("checkin’ the lining");
    return setCta("loading…", { disabled: true, busy: true });
  }
  const picked = rcPicked(), n = picked.length, burns = picked.filter((a) => rc.burnSel.has(a.address)).length;
  if (!rcHasWork()) {
    $("#sumCount").textContent = "nothing to close"; feeEl.replaceChildren(h("span", {}, "nothing was signed or sent"));
    caption("not a speck of lint");
    return setCta("back to your dust", { action: leaveCleanup });
  }
  $("#sumCount").textContent = n ? plural(n, "account") : "nothing picked";
  $("#sumWorth").textContent = n ? `${solApprox(rcTotal())} SOL back` : "";
  noFee(n ? rcTotal() : 0);
  if (!n) { caption("pick the empty pockets"); return setCta("pick some accounts", { disabled: true }); }
  caption(burns ? "burns are final. double-check the list" : n >= 50 ? "that’s a lot of empty pockets" : "every empty pocket’s sittin’ on rent. let’s get it back");
  return setCta(burns ? `review ${n} · ${burns} burn${burns === 1 ? "" : "s"}` : `review ${plural(n, "close")}`, { action: () => buildReclaim() });
}

/* ---- build, sign, send ---- */
async function buildReclaim({ notice = null } = {}) {
  const rc = state.rc;
  if (state.busy || !state.account) return;
  const picked = rcPicked().slice(0, RC_MAX);
  if (!picked.length) return;
  closeAllPops(); clearToasts();
  const ep = ++state.epoch, ctrl = new AbortController(), owner = state.account.address;
  const burn = rc.burnAck ? picked.filter((a) => rc.burnSel.has(a.address)).map((a) => a.address) : [];
  const close = picked.filter((a) => rc.sel.has(a.address)).map((a) => a.address);
  state.busy = "building"; rc.plan = null; rc.notice = notice;
  rc.building = { ctrl, n: picked.length, back: picked.reduce((s, a) => s + rcBack(a), 0) };
  window.scrollTo({ top: 0, behavior: reduced() ? "instant" : "smooth" });
  setPose(sceneMascot("cleanup"), 12, { mode: "wiggle" });
  renderCleanup(); renderBar();
  let res;
  try {
    res = await api("/api/reclaim", { owner, close, burn }, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError" || ep !== state.epoch) return;
    rc.building = null; setIdle();
    if (e.status === 429) startCooldown(60);
    renderCleanup(); renderBar();
    setPose(sceneMascot("cleanup"), 4);
    toast({ title: "couldn’t build the cleanup", body: `${e.message} Nothing was signed or sent.`, tone: "bad" });
    return;
  }
  if (ep !== state.epoch) return;
  // the server's re-read is what gets signed; names are kept with each account so the run can still label them
  // after the list refreshes and the closed accounts are gone from it
  const named = (x) => { const a = rcAcc(x.address); return { mint: x.mint, symbol: a?.symbol ?? null, name: a?.name ?? null, verified: !!a?.verified }; };
  const lam = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const txs = (Array.isArray(res?.txs) ? res.txs : []).filter((t) => t && typeof t.tx === "string" && Array.isArray(t.accounts)).map((t) => ({
    tx: t.tx, bytes: lam(t.bytes), lamports: lam(t.lamports), feeLamports: lam(t.feeLamports),
    accounts: t.accounts.filter((a) => a && typeof a.address === "string" && B58RE.test(a.address) && typeof a.mint === "string" && B58RE.test(a.mint))
      .map((a) => ({ address: a.address, ...named(a), action: a.action === "burn+close" ? "burn+close" : "close", lamports: lam(a.lamports), native: !!a.native })),
  }));
  const skipped = (Array.isArray(res?.skipped) ? res.skipped : []).filter((s) => s && typeof s.address === "string").map((s) => ({ address: s.address, reason: String(s.reason || "skipped").slice(0, 160) }));
  rc.building = null;
  rc.plan = { txs, skipped, owner, at: Date.now(), sent: false, burns: txs.reduce((s, t) => s + t.accounts.filter((a) => a.action !== "close").length, 0) };
  setIdle();
  renderCleanup(); renderBar();
  setPose(sceneMascot("cleanup"), txs.length ? 19 : 4);
  srSay(txs.length ? `Review ready: ${plural(txs.length, "transaction")}, one wallet prompt.${skipped.length ? ` ${skipped.length} skipped.` : ""}` : "Nothing could be closed. Reasons are listed.");
}
function rcCancelBuild() {
  const rc = state.rc;
  rc.building?.ctrl?.abort();
  state.epoch++; rc.building = null; setIdle();
  renderCleanup(); renderBar();
  setPose(sceneMascot("cleanup"), 2);
  toast({ title: "cleanup cancelled", body: "Nothing was signed or sent." });
}
function rcCinema(p) {
  const n = p.txs.length, back = p.txs.reduce((s, t) => s + t.lamports, 0), accts = p.txs.reduce((s, t) => s + t.accounts.length, 0);
  return { n, facts: `${state.wallet?.name || "Your wallet"} is asking you to approve ${plural(n, "transaction")} in one prompt. Check the balance changes it shows. Nothing is sent until you approve.`,
    items: [
      h("li", {}, icon("spark"), h("span", {}, "Coming in: ", h("b", {}, `${solApprox(back)} SOL`), ` from closing ${plural(accts, "account")}.`)),
      p.burns > 0 && h("li", { class: "ask-warn" }, icon("flame", "i pink"), h("span", {}, h("b", {}, `${plural(p.burns, "token")} ${p.burns === 1 ? "leaves" : "leave"} for good. `), "Burned, not sold.")),
      h("li", {}, icon("spark"), h("span", {}, "No fee. Spacedust never holds your funds or keys. Your wallet signs."))] };
}
async function approveReclaim() {
  const rc = state.rc, p = rc.plan;
  if (!p || !p.txs.length || state.busy || p.sent) return; // never signed twice once anything went out
  if (state.pendingAccounts || p.owner !== state.account?.address || !liveAccountOk(p.owner)) return accountMoved();
  // accounts can change while a review sits on screen (a token arrives, an account closes elsewhere)
  if (Date.now() - p.at > RC_TTL_MS) return buildReclaim({ notice: "The review was a few minutes old, so every account was checked again. Look it over, then approve." });
  const feature = state.wallet?.features?.["solana:signTransaction"];
  if (!feature) { toast({ title: "this wallet can’t sign here", body: "Pick a wallet that supports Solana transaction signing.", tone: "bad" }); return; }
  closeAllPops(); clearToasts();
  const ep = state.epoch;
  state.busy = "signing"; state.signing = "reclaim"; rc.notice = null;
  $("#main").inert = true;
  renderCleanup(); renderBar();
  const unlock = () => { $("#main").inert = false; };
  let fresh;
  try {
    fresh = await api("/api/refresh", { txs: p.txs.map((t) => t.tx) });
    if (!Array.isArray(fresh?.txs) || fresh.txs.length !== p.txs.length) throw new ApiError("The server returned the wrong number of transactions.", 500);
  } catch (e) {
    if (ep !== state.epoch) return;
    unlock(); setIdle(); renderCleanup(); renderBar();
    if (e.status === 429) startCooldown(30);
    toast({ title: "couldn’t prepare the transactions", body: `${e.message} Nothing was signed or sent.`, tone: "bad" });
    return;
  }
  if (ep !== state.epoch) return;
  const acct = state.wallet?.accounts?.find?.((a) => a.address === p.owner) || state.account;
  if (state.pendingAccounts || p.owner !== state.account?.address || !liveAccountOk(p.owner)) { unlock(); setIdle(); return accountMoved(); }
  showCinema(rcCinema(p));
  let signed;
  try {
    const res = await feature.signTransaction(...fresh.txs.map((tx) => ({ account: acct, transaction: b64ToBytes(tx), chain: "solana:mainnet" })));
    if (ep !== state.epoch) return; // the user stopped waiting: a late signature is dropped and never sent
    if (!Array.isArray(res) || res.length !== p.txs.length) throw new Error("The wallet returned a different number of transactions than it was asked to sign.");
    signed = res.map((r) => bytesToB64(r.signedTransaction));
  } catch (e) {
    if (ep !== state.epoch) return;
    hideCinema(); setIdle(); renderCleanup(); renderBar();
    toast(isReject(e)
      ? { title: "cancelled in wallet. nothing was sent", body: "The review is still here. Approve again when you’re ready." }
      : { title: "the wallet couldn’t sign", body: `${String(e?.message || e).slice(0, 160)} Nothing was sent.`, tone: "bad" });
    setPose(sceneMascot("cleanup"), 4);
    setTimeout(() => setPose(sceneMascot("cleanup"), 19, { hop: false }), 1600);
    return;
  }
  p.sent = true;
  hideCinema();
  const want = fresh.txs.map(blockhashOf);
  runReclaimSend(signed, fresh.lastValidBlockHeight, signed.map((s, i) => !!want[i] && blockhashOf(s) === want[i]));
}
async function runReclaimSend(signed, lastValid, keptHash = []) {
  const ep = ++state.epoch, rc = state.rc, p = rc.plan;
  const lv = Number.isFinite(lastValid) ? lastValid : null;
  state.busy = "sending";
  state.run = { kind: "reclaim", items: p.txs.map((t, i) => ({ ...t, i, status: "sending", sig: sigOf(signed[i]), note: null, lastValid: keptHash[i] ? lv : null, past: 0 })), done: false, sim: !!dev?.simulated };
  await go("drop");
  if (ep !== state.epoch) return;
  $("#stampWrap").hidden = true; $("#result").hidden = true; $("#drop-title").classList.remove("as-stamp"); showComplete(false);
  $("#drop-title").textContent = "sendin’ it";
  $("#dropFacts").textContent = `${plural(p.txs.length, "transaction")} signed. Sending them now. Each one lands on its own, so a slow one never holds up the rest.`;
  renderSimNote();
  setPose(sceneMascot("drop"), 6, { mode: "wiggle" });
  renderDrop(); renderBar();
  const items = state.run.items;
  if (!(await sendAndTrack(items, signed, ep, RC_COPY))) return;
  state.run.done = true; setIdle();
  rc.plan = null;
  // what closed is gone right away (the refresh below confirms it), so "clean up more" counts only what's left
  const gone = new Set(items.filter((t) => t.status === "confirmed").flatMap((t) => t.accounts.map((a) => a.address)));
  if (rc.accounts) { rc.accounts = rc.accounts.filter((a) => !gone.has(a.address)); for (const a of gone) { rc.sel.delete(a); rc.burnSel.delete(a); } }
  renderDrop(); renderResult(); renderBar();
  srSay(`${items.filter((i) => i.status === "confirmed").length} of ${items.length} confirmed.`);
  // what's left is picked afresh next time (a simulated run closed nothing, so its accounts come back picked too)
  rc.resetSel = true;
  if (!state.run.sim) loadAccounts({ silent: true });
  // only burns change the pockets (closes empty accounts the token list never showed), so only they re-read it
  const burnedOk = items.some((t) => t.status === "confirmed" && t.accounts.some((a) => a.action !== "close"));
  if (burnedOk && !state.run.sim && state.rowsFor === state.account?.address) loadHoldings({ silent: true });
}
function rcPill(t) {
  return t.status === "sending" ? h("span", { class: "pill" }, icon("bolt", "i"), "sending…")
    : t.status === "confirming" ? h("span", { class: "pill" }, h("span", { class: "spin" }), t.processed ? "processed…" : "confirming…")
    : t.status === "confirmed" ? h("span", { class: "pill ok" }, icon("check", "i"), "confirmed")
    : t.status === "failed" ? h("span", { class: "pill bad" }, icon("x", "i"), "failed")
    : t.status === "never" ? h("span", { class: "pill exp" }, "not sent")
    : h("span", { class: "pill exp" }, "expired");
}
function renderReclaimDrop(r) {
  $("#runList").replaceChildren(...r.items.map((t, i) => {
    const sol = t.sig && !r.sim && h("a", { class: "sol-link", href: "https://solscan.io/tx/" + encodeURIComponent(t.sig), target: "_blank", rel: "noreferrer" }, "view on Solscan", icon("ext", "i"));
    const right = h("div", { class: "tx-right" }, rcPill(t), (t.status === "confirmed" || t.status === "failed") && sol);
    const note = t.note ? h("p", { class: "tx-note" + (t.status === "failed" ? " bad" : "") }, t.note) : null;
    return rcTxLi(t, i, { right, note, gone: ["failed", "expired", "never"].includes(t.status), details: false });
  }));
}
function renderReclaimResult() {
  const r = state.run, items = r.items, ok = items.filter((i) => i.status === "confirmed"), bad = items.filter((i) => i.status !== "confirmed");
  const back = ok.reduce((a, t) => a + t.lamports, 0), closed = ok.reduce((a, t) => a + t.accounts.length, 0), burned = ok.reduce((a, t) => a + t.accounts.filter((x) => x.action !== "close").length, 0);
  const res = $("#result"); res.hidden = false;
  const m = sceneMascot("drop"), title = $("#drop-title");
  if (!bad.length) {
    $("#dropFacts").textContent = `Every transaction landed. About ${solAmt(back)} SOL is back in your wallet from ${plural(closed, "closed account")}${burned ? `, with ${plural(burned, "dust token")} burned on the way` : ""}. No fee.`;
    $("#stampWrap").hidden = false; title.classList.add("as-stamp"); title.textContent = "rent’s back: all aired out";
    $("#stampText").textContent = "rent’s back"; $("#stamp").classList.add("long");
    const st = $("#stamp"); st.classList.remove("slam"); void st.offsetWidth; if (!reduced()) st.classList.add("slam");
    showComplete(true);
    feathers();
  } else if (!ok.length) {
    const allExp = bad.every((b) => b.status === "expired" || b.status === "never");
    title.classList.remove("as-stamp"); title.textContent = allExp ? "it expired before landing" : "nothing closed";
    $("#dropFacts").textContent = allExp ? "Solana transactions are only valid for about a minute, and these didn’t land in time. Nothing happened on-chain. Try again to get fresh ones." : "None of these went through. Nothing was closed or burned, and your accounts are as they were. Details are below each one.";
    $("#stampWrap").hidden = true;
    showComplete(false);
    setPose(m, 1);
  } else {
    title.classList.remove("as-stamp"); title.textContent = "mostly aired out";
    $("#dropFacts").textContent = `${plural(bad.length, "transaction")} didn’t go through, so ${bad.length === 1 ? "its accounts are" : "their accounts are"} still open. The other ${ok.length} landed: about ${solAmt(back)} SOL is back.`;
    $("#stampWrap").hidden = true;
    showComplete(false);
    setPose(m, 4);
  }
  if (!ok.length) { fill(res, h("p", { class: "result-note" }, "Nothing was closed and no fee was taken. Your accounts haven’t changed.")); return; }
  const backStat = h("div", { class: "stat received" }, h("p", { class: "overline" }, "rent back"), h("p", { class: "stat-v" }, h("span", { class: "odo-host" }), h("small", {}, "SOL")), h("p", { class: "stat-s" }, `${solUsd(back) ? `≈\u00a0${solUsd(back)} at today’s SOL price, ` : ""}from ${plural(closed, "closed account")}. Your wallet shows the exact amount.`));
  fill(res,
    h("div", { class: "stats" }, backStat,
      h("div", { class: "stat" }, h("p", { class: "overline" }, "closed"), h("p", { class: "stat-v" }, String(closed), h("small", {}, closed === 1 ? "account" : "accounts")), h("p", { class: "stat-s" }, `in ${plural(ok.length, "transaction")}`)),
      burned ? h("div", { class: "stat burned" }, h("p", { class: "overline pink" }, "burned"), h("p", { class: "stat-v" }, String(burned), h("small", {}, burned === 1 ? "token" : "tokens")), h("p", { class: "stat-s" }, "dust gone for good"))
        : h("div", { class: "stat" }, h("p", { class: "overline" }, "fee"), h("p", { class: "stat-v" }, "0"), h("p", { class: "stat-s" }, "no fee on the cleanup"))),
    h("div", { class: "result-actions" }, h("button", { class: "btn-ghost sm", type: "button", onclick: rcCopySummary }, icon("copy", "i i-sm"), "copy summary"), h("span", { id: "resRc", class: "res-rc" })),
    bad.length > 0 && h("p", { class: "result-note" }, "“Try again” rebuilds just the accounts that are still open. The ones that closed are done. Failed transactions cost only the network fee; expired ones cost nothing."));
  odometer(backStat.querySelector(".odo-host"), solAmt(back), backStat);
  renderResultReclaim();
}
function renderReclaimDropBar(r, feeEl) {
  const items = r.items, n = items.length, c = items.filter((i) => i.status === "confirmed").length;
  $("#sumCount").textContent = `${c} of ${n} confirmed`;
  feeEl.replaceChildren(h("span", {}, r.done ? (r.sim ? "simulated run · nothing was sent" : "no fee · your accounts are refreshing") : "keep this tab open until it’s done"));
  if (!r.done) { caption("sent. waitin’ on the network…"); return setCta(`sending ${n}…`, { disabled: true, busy: true }); }
  const failed = items.filter((i) => i.status !== "confirmed");
  const more = rcEmptiesMine().length;
  if (!failed.length) { caption(more ? "rent’s back. more pockets to air out" : "rent’s back. pockets aired out"); return setCta("back to your dust", { action: dustAgain, alt: more ? { label: "clean up more", run: () => openCleanup(), wide: true } : null }); }
  const retry = () => rcRetry(failed);
  if (!c) { caption(failed.every((f) => f.status === "expired" || f.status === "never") ? "it expired before landing" : "nothing closed this time"); return setCta("try again", { action: retry, alt: { label: "done", run: dustAgain } }); }
  caption("mostly aired out");
  return setCta(failed.length === 1 ? "try that one again" : `try the ${failed.length} again`, { action: retry, alt: { label: "done", run: dustAgain } });
}
// a retry is always a fresh read and a fresh build of what didn't close
function rcRetry(failed) {
  if (state.busy) return;
  const addrs = failed.flatMap((t) => t.accounts.map((a) => a.address));
  state.run = null;
  openCleanup({ select: addrs });
}
async function rcCopySummary() {
  const r = state.run, ok = r.items.filter((i) => i.status === "confirmed");
  const back = ok.reduce((a, t) => a + t.lamports, 0), closed = ok.reduce((a, t) => a + t.accounts.length, 0);
  const text = `spacedust cleanup: ${ok.length} of ${r.items.length} confirmed. ${solApprox(back)} SOL of rent back from ${plural(closed, "closed account")}, no fee.${r.sim ? " (dev simulation, nothing was sent)" : ""}\n` + ok.map((t) => `https://solscan.io/tx/${t.sig}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast({ title: "summary copied", tone: "ok", timeout: 2200 }); }
  catch { toast({ title: "couldn’t copy", body: "Your browser blocked clipboard access." }); }
}

/* ================= copy buttons, mascot boops ================= */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]"); if (!b) return;
  const text = b.dataset.copy === "mint" ? state.plan?.burnMint || burnId() || "" : state.account?.address || "";
  if (!text) return;
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch { ok = false; }
  const u = b.querySelector("use"); if (u && ok) { u.setAttribute("href", "#i-check"); setTimeout(() => u.setAttribute("href", "#i-copy"), 1200); }
  toast(ok ? { title: b.dataset.copy === "mint" ? "mint address copied" : "address copied", tone: "ok", timeout: 2000 } : { title: "couldn’t copy", body: "Your browser blocked clipboard access. Select the text instead." });
});
document.addEventListener("click", (e) => { const m = e.target.closest(".mascot"); if (m && m.tagName === "BUTTON") boop(m); });

/* ================= boot ================= */
const app = {
  state, go, renderBar, renderPockets, renderPocketsMeta, renderAside, renderCut, renderRing, syncRows, loadHoldings, loadConfig,
  openWallets, openPop, closePop, closeAllPops, clearToasts, toast, startPreview, approve, setOut, outs, burnOut, connect, disconnect,
  setPose, sceneMascot, hideCinema, placePopover, stopRing, startRing, autoSelect, keepMax, rowEls, registry, DEFAULT_OUTS, DEFAULT_SET, TTL_MS, MAX, setIdle,
  rcFresh, openCleanup, loadAccounts, buildReclaim, approveReclaim, renderCleanup, syncCleanup, RC_MAX,
};
if (DEV_REQ) {
  try { dev = await (await import("/dev.js")).init(app, params); }
  catch (e) { dev = null; console.warn("dev mode unavailable", e); }
  devSettled = true;
}
buildPresets();
buildStill();
renderSlate(); renderBar(); renderSetSummary();
openingShutter();
drawNameplate();
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));
setTimeout(() => { state.booted = true; if (dlg.open && !dialogConnecting()) openWallets(); }, 700);
loadConfig();
addEventListener("resize", () => { movePresetThumb(); });
new IntersectionObserver(([e]) => { root.classList.toggle("bar-cta", !e.isIntersecting && state.scene === "title"); }, { rootMargin: "-60px 0px -120px 0px" }).observe($("#heroConnect"));
document.addEventListener("visibilitychange", () => { $$(".trails .orbit").forEach((g) => (g.style.animationPlayState = document.hidden ? "paused" : "")); });
