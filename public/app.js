/* duster · sell your dust in one prompt
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
const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;
const pct = (bps) => +(bps / 100).toFixed(2) + "%";
const RENT_SOL = 0.00203928; // rent held by a standard token account (Token-2022 accounts hold a bit more), returned when it's closed

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

const state = {
  scene: "title", epoch: 0, busy: null,
  fee: undefined, feeErr: false, prices: {},
  wallets: [], wallet: null, account: null, connecting: false, booted: false,
  rows: [], selected: new Set(), loading: false, loadError: null, cooldownUntil: 0,
  preset: 2, range: { min: 0, max: 2 }, query: "", includeBurn: false,
  out: DEFAULT_OUTS[0], customAck: false,
  set: { ...DEFAULT_SET, ...sanitizeSet(store.get("set", {})) },
  plan: null, planAt: 0, building: null, stale: false, staleWhy: null, notice: null,
  run: null, pendingAccounts: null, tempLoss: null,
};
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
    throw new ApiError("Couldn’t reach Duster. Check your connection and try again.", 0);
  }
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok || j === null) {
    // a rate limit is Duster's problem, not the user's; the UI shows the exact wait next to it
    const msg = res.status === 429 ? "Duster is busy right now. Try again when the timer runs out."
      : j?.error || (res.status === 504 ? "The server timed out. Try fewer tokens at once." : `Request failed (${res.status}).`);
    throw new ApiError(/[.!?]$/.test(msg) ? msg : msg + ".", res.status);
  }
  return j;
}

/* ================= scene control ================= */
const SCENES = { title: ["sc. 00", "title", 0], pockets: ["sc. 01", "the pockets", 1], cut: ["sc. 02", "the cut", 2], wallet: ["sc. 03", "your move", 3], drop: ["sc. 04", "the drop", 4] };
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
    renderSlate(); renderBar();
  };
  if (instant || state.scene === scene) { apply(); return Promise.resolve(); }
  return vt(apply, [back ? "back" : "forward"]);
}
function renderSlate() {
  const key = root.classList.contains("cinema-on") ? "wallet" : state.scene;
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
const POSE_DIMS = { 1: [204, 335], 2: [254, 334], 3: [254, 334], 4: [170, 330], 5: [311, 332], 6: [252, 326], 7: [267, 342], 8: [262, 321], 9: [257, 324], 10: [293, 318], 11: [317, 321], 12: [283, 321], 13: [226, 321], 14: [270, 328], 15: [272, 327], 16: [267, 328], 17: [199, 329], 18: [271, 329], 19: [231, 330] };
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
dlg.addEventListener("close", () => { if (dialogConnecting()) abandonConnect(); });
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
      h("p", { class: "facts" }, mobile ? "This browser doesn’t have a Solana wallet. Open Duster inside your wallet app’s browser instead:" : "This browser doesn’t have a Solana wallet extension. Install one, then reload this page."),
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
      h("p", { class: "wd-fine" }, "Works with Phantom, Solflare, Backpack and other Wallet Standard wallets. Connecting is read-only: Duster sees your address and balances. Nothing is signed until you approve a swap."));
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
  go("pockets").then(() => loadHoldings());
}
// every path that ends a busy phase goes through here, so a deferred account switch is never lost
function setIdle() {
  state.busy = null;
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
  state.wallet = state.account = null; state.rows = []; state.selected.clear(); state.plan = null; state.run = null; state.building = null; state.busy = null;
  state.pendingAccounts = null; state.includeBurn = false; state.stale = false;
  for (const el of rowEls.values()) el.remove(); rowEls.clear();
  root.classList.add("revisit");
  go("title", { back: true });
  if (!quiet) toast({ title: "disconnected. come back dusty", body: "Duster no longer sees this wallet." });
}
$("#heroConnect").addEventListener("click", () => (state.account ? go("pockets") : openWallets()));
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
    $("#sumCount").textContent = plural(state.plan?.txs.length || 0, "transaction");
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
      $("#sumCount").textContent = "nothing to dust"; caption("spotless. nothing to dust");
      return setCta("switch wallet", { action: () => openWallets() });
    }
    if (!n) { caption("pick what’s collectin’ dust"); return setCta("pick some dust", { disabled: true }); }
    if (n > MAX) { caption("that’s a lot of dust. one run at a time"); return setCta(`keep the ${MAX} largest`, { action: keepMax }); }
    if (unverifiedOut() && !state.customAck) { caption("check that address first"); return setCta("confirm the address first", { disabled: true }); }
    caption(isBurnOut() ? "straight to the source. no fee" : unverifiedOut() ? "double-check that address" : n >= 8 ? "found the dust in every corner" : "say less");
    return setCta(`preview ${plural(n, "swap")}`, { action: () => startPreview() });
  }

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
    if (!n) {
      caption(allRateLimited(p) ? "hold up. the server needs a breather" : "nothing made the cut");
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
    const c = r.items.filter((i) => i.status === "confirmed").length, n = r.items.length;
    $("#sumCount").textContent = `${c} of ${n} confirmed`;
    feeEl.replaceChildren(h("span", {}, r.done ? (r.sim ? "simulated run · nothing was sent" : "your token list is refreshing") : "keep this tab open until it’s done"));
    if (r.retrying) { caption("checkin’ what landed…"); return setCta("checking balances…", { disabled: true, busy: true }); }
    if (!r.done) { caption("sent. waitin’ on the network…"); return setCta(`sending ${n}…`, { disabled: true, busy: true }); }
    const failed = r.items.filter((i) => i.status !== "confirmed");
    if (!failed.length) { caption("clean sweep. not a speck left"); return setCta("dust again", { action: dustAgain }); }
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
    if ((state.scene === "pockets" && state.loadError) || (state.scene === "cut" && !state.busy)) renderBar();
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
    state.loading = true; state.loadError = null; state.rows = []; state.selected.clear(); state.plan = null;
    renderPockets();
    setPose(sceneMascot("pockets"), 12, { mode: "wiggle" });
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
  state.rows = rows.filter((r) => r && typeof r.mint === "string").map((r) => ({
    mint: r.mint, amount: Number(r.amount) || 0, frozen: !!r.frozen,
    usd: typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : null,
    symbol: typeof r.symbol === "string" ? r.symbol.slice(0, 32) : null,
    name: typeof r.name === "string" ? r.name.slice(0, 64) : null,
    icon: typeof r.icon === "string" ? r.icon : null, verified: !!r.verified,
  })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
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
// Remote icons only for verified tokens. An unverified token's icon host is picked by whoever minted it (often a
// per-wallet airdrop), so loading it would tell them this wallet is on Duster right now. Those get a letter
// badge instead. Icons that failed once are not requested again.
const badIcons = new Set();
function tokIcon(t, extra = "") {
  const label = (t.symbol || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?";
  const isBurn = !!(t.burn || (burnId() && (t.mint || t.id) === burnId()));
  const el = h("span", { class: "tok-ico" + (isBurn ? " burn" : "") + (extra ? " " + extra : ""), "aria-hidden": "true" }, label);
  el.style.setProperty("--h", String(hash(t.mint || t.id || "x") % 360));
  const src = t.icon;
  if ((t.verified || isBurn) && typeof src === "string" && /^https:\/\/[^\s"'<>]+$/i.test(src) && src.length < 2048 && !badIcons.has(src)) {
    const img = h("img", { src, alt: "", referrerpolicy: "no-referrer", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { badIcons.add(src); img.remove(); });
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
      ? `Nothing here has a reliable price${unpriced ? ` (${plural(unpriced, "token")} without one, listed below)` : ""}, so there’s nothing Duster can sell safely.`
      : "No tokens besides SOL, so there’s nothing to dust.";
    fill(pkState, stateStill(13, "not a speck in sight", "Dusty checked every pocket. Come back when the airdrops pile up."),
      h("div", { class: "state-actions" },
        h("button", { class: "btn-ghost sm", type: "button", onclick: () => openWallets() }, icon("wallet", "i i-sm"), "switch wallet"),
        h("button", { class: "btn-text sm", type: "button", onclick: () => loadHoldings() }, icon("refresh", "i i-sm"), "check again")));
  } else {
    $("#pk-title").textContent = "pick your dust";
    syncRows({ stagger });
  }
  $(".pk-aside").hidden = !state.loading && (!!state.loadError || empty);
  // one mascot per viewport: the set piece replaces the cameo in the empty and error states
  sceneMascot("pockets").hidden = !state.loading && (!!state.loadError || empty);
  renderPocketsMeta(); renderAside(); renderBar();
  requestAnimationFrame(movePresetThumb);
}
function renderPocketsMeta() {
  if (state.loading) { $("#hiddenList").hidden = true; $("#keptLine").hidden = true; return; }
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
        h("span", {}, state.includeBurn ? "It’s selectable now. Selling it while every swap buys and burns it mostly cancels out." : "Duster never picks the burn token for you. Selling it while every swap buys and burns it mostly cancels out.")),
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
  // Chunks share one Jupiter rate limit (per account), so they only run side by side when the plan has room.
  const lanes = Math.max(1, Math.min(3, Math.floor((state.jupRps || 1) / 3)));
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

function humanSkip(s, p) {
  const r = String(s.reason || "");
  let m;
  if (r === "rate limited") return { why: "Not quoted yet: Duster is busy right now. Nothing was built or signed.", fix: "retry" };
  if (r.startsWith("quote service busy")) return { why: "Jupiter’s quote service is busy right now. Try again in a moment.", fix: "retry" };
  if (r.startsWith("no route")) return { why: "No market for this token right now.", fix: "retry" };
  if ((m = r.match(/route returns \$([\d.]+) for \$([\d.]+)/))) {
    const got = +m[1], inn = +m[2], loss = inn > 0 ? Math.max(0, (1 - got / inn) * 100) : 100;
    const need = Math.ceil(loss + 1);
    return { why: `Would return ${usdP(got)} for ${usdP(inn)} (−${loss.toFixed(0)}% vs. market). Your limit is ${p.set.loss}%.`, loss: need <= 50 ? need : null,
      note: need > 50 ? "That’s more than the 50% maximum, so it can’t be included." : null };
  }
  if (r.startsWith("buy-and-burn")) return { why: "The burn route is busy right now, and a swap never goes through without its fee. Try again in a moment.", fix: "retry" };
  if (r.startsWith("route too large")) return p.out.id === SOL
    ? { why: "This token’s route is too complex to fit in one transaction with its burn, so it can’t be sold here right now." }
    : { why: "The route is too complex to fit in one transaction with its burn. Swapping into SOL usually leaves more room.", fix: "sol" };
  if (r.startsWith("simulation failed")) return { why: "This token can’t be sold right now: its swap failed in simulation, so it was skipped. Nothing was sent.", raw: r };
  if (r === "account frozen") return { why: "This token account is frozen by its issuer, so it can’t be moved." };
  if (r === "no reliable price") return { why: "No reliable price right now, so the swap can’t be checked against the market." };
  if (r === "not in wallet") return { why: "It’s no longer in this wallet." };
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
  $("#cut-title").textContent = n ? (state.stale ? "quotes went stale" : "review the cut") : rl ? "preview paused" : "nothing made the cut";
  $("#cutFacts").textContent = n && state.stale
    ? (state.staleWhy === "settings" ? "These quotes used your old protection settings. Refresh to quote again with the new ones, then approve. Nothing was sent."
      : `The oldest of these quotes is more than ${TTL_MS / 1000} seconds old, so prices may have moved. Refresh to get fresh ones, then approve. Nothing was sent.`)
    : n ? `${plural(n, "token")} ready, one transaction each${p.feeApplied ? ", each with its own buy and burn" : ""}. Your wallet will ask once for all ${n}.${p.skipped.length ? ` Another ${p.skipped.length} ${p.skipped.length === 1 ? "was" : "were"} skipped (reasons below).` : ""}`
    : rl ? "Duster is rate-limiting previews for a moment. Nothing was built or signed. Try again when the timer runs out."
    : "None of these tokens could be swapped safely right now. Nothing was built or signed. Reasons and fixes are below.";
  fill(heroEl,
    h("div", { class: "ch-block" }, h("p", { class: "overline" }, "you sell"), h("p", { class: "ch-big" }, plural(n, "token")), h("p", { class: "ch-sub" }, `worth ≈ ${usd(t.usdIn)}`)),
    svgArrow(),
    h("div", { class: "ch-block ch-out" }, h("p", { class: "overline" }, "you get", state.stale && n && h("span", { class: "old-tag" }, "old quote")), h("p", { class: "ch-big" }, `≈ ${outAmt(t.receive, o)}`, h("small", {}, symOf(o))),
      h("p", { class: "ch-sub" }, t.minReceive != null ? `at least ${outAmt(t.minReceive, o)} ${symOf(o)}${p.feeApplied ? ", after the fee" : ""}` : p.feeApplied ? "after the fee" : "")));
  $("#cutListLabel").replaceChildren(h("span", {}, `tracklist · ${plural(n, "transaction")}`), n > 0 && h("span", { class: "tl-col" }, "vs. market"));
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
        h("li", {}, icon("spark"), h("span", {}, "Check the balance changes it shows. Duster never holds your funds or keys, and nothing is sent until you approve.")))));
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
  state.busy = "signing"; state.notice = null;
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
  showCinema();
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
function showCinema() {
  const p = state.plan, n = p.txs.length, o = p.out, t = planTotals(p);
  closeAllPops();
  $("#cinemaFacts").textContent = `${state.wallet?.name || "Your wallet"} is asking you to approve ${plural(n, "transaction")} in one prompt. Check the balance changes it shows. Nothing is sent until you approve.`;
  fill($("#cinemaList"),
    unverifiedOut(o) && h("li", { class: "ask-warn" }, icon("warn", "i warn"), h("span", {}, h("b", {}, "Unverified token coming in. "), "Its address: ", h("span", { class: "mono mint-inline" }, o.id))),
    h("li", {}, icon("spark"), h("span", {}, "You’ll see ", h("b", {}, `${plural(n, "token")} leaving`), ". Coming in: ", receiveLine(p, t, n), ".")),
    p.feeApplied && h("li", {}, icon("flame", "i pink"), h("span", {}, `${burnSym()} may show as 0. It’s bought and burned inside each transaction.`)),
    h("li", {}, icon("spark"), h("span", {}, "Duster never holds your funds or keys. Your wallet signs.")));
  $("#cinemaStuck").hidden = true;
  clearTimeout(hintT); hintT = setTimeout(() => { $("#cinemaStuck").hidden = false; }, 15000);
  const c = $("#cinema"); c.classList.remove("out"); c.hidden = false;
  root.classList.add("cinema-on");
  $("#main").inert = true; $("#barTop").inert = true; $("#barBot").inert = true;
  c.focus({ preventScroll: true });
  renderSlate(); renderBar();
}
function hideCinema(instant = false) {
  clearTimeout(hintT);
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
  state.epoch++;
  hideCinema(); setIdle();
  state.stale = true; state.staleWhy = "time";
  renderCut(); renderBar();
  cta.focus({ preventScroll: true });
  setPose(sceneMascot("cut"), 1);
  toast({ title: "stopped waiting for the wallet", body: "Nothing was sent. If your wallet still shows the request, reject it there. Refresh the quotes to try again." });
}
$("#cinemaBack").addEventListener("click", stopWaiting);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("cinema-on")) { e.preventDefault(); stopWaiting(); } });

/* ================= SC. 04 · send + confirm ================= */
function humanErr(err) {
  const s = JSON.stringify(err) || "";
  if (/InsufficientFundsForFee|InsufficientFundsForRent/.test(s)) return "Not enough SOL for network fees.";
  const m = s.match(/"Custom":(\d+)/);
  if (m && [6001, 6017, 6024].includes(+m[1])) return "The price moved past your slippage limit.";
  if (m && +m[1] === 1) return "Not enough balance for this swap.";
  if (/BlockhashNotFound/.test(s)) return "It expired before it landed.";
  return "It failed on-chain.";
}
const CHECKING = "No clear answer from the network yet, so Duster is checking by signature…";
async function runSend(signed, lastValid, keptHash = []) {
  const ep = ++state.epoch;
  const p = state.plan, t = planTotals(p);
  const lv = Number.isFinite(lastValid) ? lastValid : null;
  state.busy = "sending";
  state.run = { items: t.items.map((x, i) => ({ ...x, i, status: "sending", sig: sigOf(signed[i]), note: null, lastValid: keptHash[i] ? lv : null, past: 0 })), done: false, out: p.out, feeApplied: p.feeApplied, burnMint: p.burnMint, close: p.set.close, sim: !!dev?.simulated };
  await go("drop");
  if (ep !== state.epoch) return;
  $("#stampWrap").hidden = true; $("#result").hidden = true; $("#drop-title").classList.remove("as-stamp");
  $("#drop-title").textContent = "sendin’ it";
  $("#dropFacts").textContent = `${plural(p.txs.length, "transaction")} signed. Sending them now. Each one lands on its own, so a slow one never holds up the rest.`;
  renderSimNote();
  setPose(sceneMascot("drop"), 6, { mode: "wiggle" });
  renderDrop(); renderBar();
  const items = state.run.items;
  try {
    const sigs = await api("/api/send", { txs: signed });
    if (ep !== state.epoch) return;
    if (!Array.isArray(sigs) || sigs.length !== items.length) throw new Error("unexpected response");
    items.forEach((it, i) => {
      const s = sigs[i];
      if (typeof s === "string") { it.sig = s; it.status = "confirming"; return; }
      const err = String(s?.error || "rejected by the network");
      // only a preflight rejection is definitive; anything else may still land, so keep watching the signature
      const definitive = !s?.uncertain && /simulation failed|expired/.test(err);
      if (it.sig && !definitive) { it.status = "confirming"; it.note = CHECKING; }
      else { it.status = "never"; it.note = `Didn’t send: ${err}. Nothing happened, and the token is still in your wallet.`; }
    });
  } catch (e) {
    if (ep !== state.epoch) return;
    // The relay answer failed or made no sense, so we can't be sure what reached the network. Track by signature.
    items.forEach((it) => { if (it.sig) { it.status = "confirming"; it.note = CHECKING; } else { it.status = "never"; it.note = `Didn’t send: ${e.message} Nothing happened.`; } });
  }
  renderDrop(); renderBar();
  const pending = () => items.filter((it) => it.status === "confirming");
  let delay = 2000, fails = 0, polls = 0;
  const started = Date.now();
  while (pending().length) {
    await sleep(delay);
    if (ep !== state.epoch) return;
    const pend = pending();
    // the block height is only needed to settle expiry: ask for it every third poll, once a minute has gone
    // by, or right after it first looked expired (expiry needs two looks in a row)
    const withH = polls++ % 3 === 2 || Date.now() - started > 50_000 || pend.some((it) => it.past);
    try {
      const res = await api(`/api/status?${withH ? "h=1&" : ""}sigs=${pend.map((it) => it.sig).join(",")}`);
      if (ep !== state.epoch) return;
      const statuses = Array.isArray(res) ? res : res?.statuses || [];
      const bh = Array.isArray(res) ? null : res?.blockHeight;
      fails = 0; delay = 2000;
      pend.forEach((it, k) => {
        const s = statuses[k];
        if (!s) return;
        it.landed = true; it.past = 0;
        if (s.err) { it.status = "failed"; it.note = `${humanErr(s.err)} Nothing was swapped or burned; only the network fee was paid. The token is still in your wallet.`; }
        else if (s.status === "confirmed" || s.status === "finalized") { it.status = "confirmed"; it.note = null; }
        else it.processed = true;
      });
      // past its last valid block height without landing, a transaction can never land. Two looks in a row,
      // because the RPC nodes behind one endpoint can disagree for a moment.
      if (Number.isFinite(bh)) for (const it of pending()) {
        if (it.landed || it.lastValid == null) continue;
        if (bh > it.lastValid) { if (++it.past >= 2) { it.status = "expired"; it.note = "Expired: it never landed, so nothing happened. The token is still in your wallet."; } }
        else it.past = 0;
      }
    } catch { fails++; delay = Math.min(12000, 2000 * 2 ** fails); } // back off and keep polling; never give up on the first error
    if (Date.now() - started > 150_000)
      for (const it of pending()) { it.status = "expired"; it.note = it.landed ? "Still not confirmed. Check your wallet history before trying again." : `Didn’t confirm in time, so it most likely expired without doing anything. Check your wallet history, then preview again. The token should still be in your wallet.`; }
    renderDrop(); renderBar();
  }
  if (ep !== state.epoch) return;
  state.run.done = true; setIdle();
  state.selected.clear();
  renderDrop(); renderResult(); renderBar();
  const c = items.filter((i) => i.status === "confirmed").length;
  srSay(`${c} of ${items.length} confirmed.`);
  loadHoldings({ silent: true }); // confirmed tokens leave the list in the background, without flashing it
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
    const st = $("#stamp"); st.classList.remove("slam"); void st.offsetWidth; if (!reduced()) st.classList.add("slam");
    setPose(m, 5, { mode: "jump" });
    feathers();
  } else if (!ok.length) {
    const allExp = bad.every((b) => b.status === "expired" || b.status === "never");
    title.classList.remove("as-stamp"); title.textContent = allExp ? "it expired before landing" : "nothing landed";
    $("#dropFacts").textContent = allExp ? "Solana transactions are only valid for about a minute, and these didn’t land in time. Nothing happened on-chain. Preview again to get fresh ones." : "None of these went through. Nothing was swapped or burned, and your tokens are still in your wallet. Details are below each one.";
    $("#stampWrap").hidden = true;
    setPose(m, 1);
  } else {
    title.classList.remove("as-stamp"); title.textContent = "mostly clean";
    $("#dropFacts").textContent = `${bad.length} didn’t go through, and ${bad.length === 1 ? "that token is" : "those tokens are"} still in your wallet. The other ${ok.length} landed.`;
    $("#stampWrap").hidden = true;
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
    h("div", { class: "result-actions" }, h("button", { class: "btn-ghost sm", type: "button", onclick: copySummary }, icon("copy", "i i-sm"), "copy summary")),
    bad.length > 0 && h("p", { class: "result-note" }, `“Preview ${bad.length === 1 ? "that one" : `the ${bad.length}`} again” builds a fresh preview of just ${bad.length === 1 ? "that token" : "those tokens"}. The ones that landed are done and won’t be sent again. Transactions that failed or expired took no fee.`));
  const host = burnStat.querySelector(".odo-host");
  if (r.feeApplied && burned) odometer(host, int(burned), burnStat);
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
function feathers() {
  if (reduced()) return;
  const m = sceneMascot("drop").getBoundingClientRect();
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
  const text = `duster: ${ok.length} of ${r.items.length} confirmed. ≈ ${outAmt(recv, o)} ${symOf(o)} received${burned ? `, ${int(burned)} ${burnSym()} burned` : ""}.${r.sim ? " (dev simulation, nothing was sent)" : ""}\n` + ok.map((t) => `https://solscan.io/tx/${t.sig}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast({ title: "summary copied", tone: "ok", timeout: 2200 }); }
  catch { toast({ title: "couldn’t copy", body: "Your browser blocked clipboard access." }); }
}
function dustAgain() {
  if (state.busy) return;
  state.epoch++; state.run = null; state.plan = null;
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
