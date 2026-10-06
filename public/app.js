const SOL = "So11111111111111111111111111111111111111112";
const DEFAULTS = [
  { id: SOL, symbol: "SOL", name: "Solana", verified: true },
  { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin", verified: true },
  { id: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether USD", verified: true },
];
const $ = (id) => document.getElementById(id);
const MAX_TOKENS = 30; // matches the server limit per preview
const PLAN_TTL_MS = 45_000; // blockhashes expire after ~60-90s
const state = { fee: undefined, wallets: [], wallet: null, account: null, rows: [], selected: new Set(), out: DEFAULTS[1], touched: false, plan: null };

// Build DOM without innerHTML: token names/symbols are attacker-controlled.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const icon = (t) => (t.icon && /^https:\/\//.test(t.icon) ? h("img", { class: "ico", src: t.icon, alt: "", referrerpolicy: "no-referrer", loading: "lazy" }) : h("span", { class: "ph" }));
const short = (m) => m.slice(0, 4) + "…" + m.slice(-4);
const usd = (n) => (n == null ? "—" : n < 0.01 && n > 0 ? "<$0.01" : "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (n) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2 });
const pct = (bps) => bps / 100 + "%";
const burnToken = () => state.fee?.burnToken;
const isBurnOut = () => !!burnToken() && state.out.id === burnToken().id;
const feeOn = () => !!state.fee && !isBurnOut();
const chips = () => [...DEFAULTS, ...(burnToken() ? [burnToken()] : [])];
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || j === null) throw new Error(j?.error || (r.status === 504 ? "The server timed out. Try fewer tokens at once." : `Request failed (${r.status})`));
  return j;
}

/* ---------- Wallet (Wallet Standard, no dependencies) ---------- */
const registry = { register(...ws) { for (const w of ws) if (!state.wallets.includes(w)) state.wallets.push(w); renderWallet(); return () => {}; } };
window.addEventListener("wallet-standard:register-wallet", (e) => e.detail(registry));
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));

function renderWallet() {
  const box = $("wallet");
  box.replaceChildren();
  if (state.account) {
    box.append(h("span", { class: "mono muted" }, short(state.account.address)), h("button", { onclick: disconnect }, "Disconnect"));
    return;
  }
  const usable = state.wallets.filter((w) => w.features["standard:connect"] && w.features["solana:signTransaction"]);
  if (!usable.length) box.append(h("span", { class: "small muted" }, "No Solana wallet detected (install Phantom, Solflare or Backpack)"));
  for (const w of usable) box.append(h("button", { class: "primary", onclick: () => connect(w) }, "Connect " + w.name));
}
async function connect(w) {
  try {
    const { accounts } = await w.features["standard:connect"].connect();
    const acc = accounts.find((a) => a.chains?.some((c) => c.startsWith("solana:"))) || accounts[0];
    state.wallet = w; state.account = acc;
    renderWallet();
    await loadHoldings();
  } catch (e) { alert("Could not connect: " + e.message); }
}
function disconnect() {
  state.wallet = state.account = null; state.rows = []; state.selected.clear(); state.plan = null;
  renderWallet(); renderTokens(); renderPlan();
}

/* ---------- Output token picker ---------- */
function renderDefaults() {
  const box = $("defaults");
  box.replaceChildren(...chips().map((t) => h("button", { class: "chip", "aria-pressed": String(state.out.id === t.id), onclick: () => setOut(t) },
    t === burnToken() && icon(t), t.symbol, t === burnToken() && h("span", { class: "badge v" }, "no fee"))));
  if (!chips().some((t) => t.id === state.out.id)) box.append(h("button", { class: "chip", "aria-pressed": "true" }, icon(state.out), state.out.symbol));
  const note = $("out-note");
  note.replaceChildren();
  if (state.fee) note.append(h("div", { class: "notice " + (feeOn() ? "warn" : "ok") },
    feeOn() ? `A ${pct(state.fee.bps)} fee applies: it buys $${burnToken().symbol} and burns it in the same transaction. Swap into ${burnToken().symbol} to skip the fee.`
      : `No fee: you're swapping into $${burnToken().symbol}.`));
  if (isBurnOut()) note.append(h("div", { class: "small muted", style: "margin-top:8px" }, h("span", { class: "mono" }, state.out.id)));
  else if (!state.out.verified) note.append(h("div", { class: "notice warn" }, "This token is not verified by Jupiter. Check the address carefully: ", h("span", { class: "mono" }, state.out.id)));
  else if (!chips().some((t) => t.id === state.out.id)) note.append(h("div", { class: "small muted", style: "margin-top:8px" }, h("span", { class: "mono" }, state.out.id)));
}
function setOut(t) { state.out = t; state.plan = null; $("results").classList.add("hidden"); $("q").value = ""; renderDefaults(); renderTokens(); renderPlan(); }
let searchTimer, searchSeq = 0;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  const box = $("results");
  if (!q) return box.classList.add("hidden");
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const res = await api("/api/tokens/search?q=" + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      box.classList.remove("hidden");
      box.replaceChildren(...(res.length ? res.map((t) => h("button", { onclick: () => setOut(t) }, icon(t),
        h("span", { style: "flex:1;min-width:0" }, h("b", {}, t.symbol), " ", h("span", { class: "muted small" }, t.name), h("div", { class: "mono muted" }, short(t.id))),
        h("span", { class: "badge" + (t.verified ? " v" : "") }, t.verified ? "verified" : "unverified"))) : [h("div", { class: "small muted", style: "padding:10px 12px" }, "No tokens found")]));
    } catch (e) { box.classList.remove("hidden"); box.replaceChildren(h("div", { class: "small", style: "padding:10px 12px;color:var(--bad)" }, e.message)); }
  }, 250);
});

/* ---------- Holdings, filter, selection ---------- */
async function loadHoldings(keepPlan) {
  $("tokens-empty").textContent = "Loading your tokens…";
  $("tokens-empty").classList.remove("hidden"); $("tokens-ui").classList.add("hidden");
  try {
    state.rows = (await api("/api/holdings?owner=" + state.account.address)).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  } catch (e) { $("tokens-empty").textContent = "Failed to load tokens: " + e.message; return; }
  $("tokens-empty").classList.add("hidden"); $("tokens-ui").classList.remove("hidden");
  if (keepPlan) { state.selected.clear(); return renderTokens(); }
  $("max").value = 2; $("min").value = 0;
  applyFilter();
}
const range = () => ({ min: Number($("min").value) || 0, max: $("max").value === "" ? Infinity : Number($("max").value) });
const inRange = (r) => r.usd != null && !r.frozen && r.usd >= range().min && r.usd <= range().max;
const selectable = (r) => r.usd != null && !r.frozen && r.mint !== state.out.id;
// Changing the filter re-selects everything in range; manual checkbox changes then stick until the next filter change.
function applyFilter() {
  state.selected = new Set(state.rows.filter((r) => inRange(r) && selectable(r)).map((r) => r.mint));
  state.plan = null;
  renderTokens(); renderPlan();
}
for (const id of ["min", "max"]) $(id).addEventListener("input", applyFilter);
$("showall").addEventListener("change", renderTokens);
$("sel-all").addEventListener("click", () => { for (const r of shown()) if (selectable(r)) state.selected.add(r.mint); state.plan = null; renderTokens(); renderPlan(); });
$("sel-none").addEventListener("click", () => { state.selected.clear(); state.plan = null; renderTokens(); renderPlan(); });
$("presets").replaceChildren(...[1, 2, 5, 10, 25].map((v) => h("button", { class: "chip small", onclick: () => { $("max").value = v; $("min").value = 0; applyFilter(); } }, "≤ $" + v)));

const shown = () => state.rows.filter((r) => $("showall").checked ? r.usd != null : inRange(r));
function renderTokens() {
  state.selected.delete(state.out.id);
  const list = $("list");
  const rows = shown();
  list.replaceChildren(...(rows.length ? rows.map(tokenRow) : [h("div", { class: "muted", style: "padding:14px" }, "No tokens in this value range.")]));
  const unpriced = state.rows.filter((r) => r.usd == null).length;
  $("unpriced").textContent = unpriced ? `${unpriced} token${unpriced > 1 ? "s" : ""} hidden: no reliable price, so they can't be valued or swapped safely.` : "";
  renderSummary();
}
function tokenRow(r) {
  const on = state.selected.has(r.mint), ok = selectable(r);
  const toggle = () => {
    if (!ok) return;
    on ? state.selected.delete(r.mint) : state.selected.add(r.mint);
    state.plan = null; renderTokens(); renderPlan();
  };
  return h("div", { class: "tok" + (on ? " sel" : "") + (ok ? "" : " off"), onclick: (e) => { if (e.target.tagName !== "INPUT") toggle(); } },
    h("input", { type: "checkbox", checked: on, disabled: !ok, "aria-label": "Swap " + (r.symbol || r.mint), onchange: toggle }),
    h("div", { class: "who" }, icon(r), h("div", { class: "name" },
      h("div", {}, h("b", {}, r.symbol || short(r.mint)), " ", r.verified ? h("span", { class: "badge v" }, "verified") : h("span", { class: "badge" }, "unverified")),
      h("span", { class: "small muted" }, r.mint === state.out.id ? "This is your target token" : r.frozen ? "Account frozen" : (r.name || "") + " · " + short(r.mint)))),
    h("div", { class: "val" }, h("b", {}, usd(r.usd)), h("div", { class: "small muted" }, num(r.amount))));
}
function renderSummary() {
  const sel = state.rows.filter((r) => state.selected.has(r.mint));
  const total = sel.reduce((s, r) => s + r.usd, 0);
  $("sum-main").textContent = sel.length ? `${sel.length} token${sel.length > 1 ? "s" : ""} selected · ≈ ${usd(total)}` : "Nothing selected";
  const tooMany = sel.length > MAX_TOKENS;
  $("sum-sub").textContent = tooMany ? `Up to ${MAX_TOKENS} tokens per run. Untick some, or run it again afterwards.` : sel.length ? `→ ${state.out.symbol}` + (state.fee ? (feeOn() ? ` · ${pct(state.fee.bps)} buy & burn fee` : " · no fee") : "") : "";
  $("sum-sub").style.color = tooMany ? "var(--warn)" : "";
  $("go").disabled = !sel.length || tooMany || !!state.busy;
}

/* ---------- Plan, sign, send ---------- */
$("go").addEventListener("click", preview);
async function preview() {
  state.busy = true; $("go").textContent = "Building…"; renderSummary();
  $("s-plan").classList.remove("hidden"); $("plan").replaceChildren(h("div", { class: "muted" }, "Fetching routes and simulating transactions…"));
  try {
    const res = await api("/api/plan", {
      owner: state.account.address, outMint: state.out.id, mints: [...state.selected],
      slippageBps: Math.round(Number($("slip").value) * 100), maxLossPct: Number($("loss").value), closeAccounts: $("close").checked,
    });
    state.plan = res; state.planAt = Date.now();
  } catch (e) { state.plan = null; $("plan").replaceChildren(h("div", { class: "notice bad" }, e.message)); }
  state.busy = false; $("go").textContent = "Preview swap"; renderSummary();
  if (state.plan) renderPlan();
}
const label = (mint) => { const r = state.rows.find((x) => x.mint === mint); return r?.symbol || short(mint); };
function renderPlan() {
  const box = $("plan");
  const p = state.plan;
  $("s-plan").classList.toggle("hidden", !p);
  if (!p) return;
  const n = p.txs.length, legs = p.txs.reduce((s, t) => s + t.legs.length, 0);
  // replaceChildren would print `false` from the conditional entries, so drop them first.
  box.replaceChildren(...[
    n ? h("p", { style: "margin-top:0" }, `${legs} swap${legs > 1 ? "s" : ""} fit into ${n} transaction${n > 1 ? "s" : ""} (Solana limits each transaction's size). Your wallet will ask you to approve them in one prompt.`)
      : h("div", { class: "notice bad" }, "Nothing could be swapped."),
    n > 0 && p.feeApplied && (() => {
      const f = p.txs.reduce((a, t) => ({ amt: a.amt + (t.fee?.amountIn ?? 0), usd: a.usd + (t.fee?.usd ?? 0), burn: a.burn + (t.fee?.burned ?? 0) }), { amt: 0, usd: 0, burn: 0 });
      return h("div", { class: "notice warn", style: "margin:0 0 6px" }, `Total fee: ${num(f.amt)} ${state.out.symbol} (${usd(f.usd)}), which buys and burns at least ${num(f.burn)} ${burnToken()?.symbol ?? ""}. Swap into ${burnToken()?.symbol ?? "the burn token"} to skip the fee.`);
    })(),
    ...p.txs.map((t, i) => h("div", { class: "plan-tx" }, h("b", {}, `Transaction ${i + 1}`), h("span", { class: "small muted" }, t.legs.length ? ` · ${t.legs.length} swap${t.legs.length > 1 ? "s" : ""}` : " · fee for the swaps above"),
      h("div", { class: "small muted" }, t.legs.map((l) => `${label(l.mint)} (${usd(l.usdIn)})`).join(", ")),
      t.fee && h("div", { class: "small" }, `Fee: ${num(t.fee.amountIn)} ${state.out.symbol} (${usd(t.fee.usd)}) buys and burns ≥ ${num(t.fee.burned)} ${burnToken()?.symbol ?? ""}`),
      h("div", { class: "small", id: "status-" + i })),
    ),
    p.skipped.length > 0 && h("details", { style: "margin-top:10px", open: true }, h("summary", {}, `${p.skipped.length} skipped`),
      p.skipped.map((s) => h("div", { class: "small muted" }, label(s.mint) + ": " + s.reason))),
    n > 0 && h("div", { style: "margin-top:12px" }, h("button", { class: "primary", id: "sign", onclick: signAndSend }, `Sign & send ${n} transaction${n > 1 ? "s" : ""}`)),
  ].filter(Boolean));
}
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b) => btoa(String.fromCharCode(...b));
async function signAndSend() {
  // A stale plan would fail on-chain with an expired blockhash, so rebuild it and let the user re-check.
  if (Date.now() - state.planAt > PLAN_TTL_MS) {
    await preview();
    $("plan").prepend(h("div", { class: "notice warn", style: "margin:0 0 10px" }, "Prices move, so the preview was refreshed. Check it again, then sign."));
    return;
  }
  const btn = $("sign"); btn.disabled = true; btn.textContent = "Waiting for wallet…";
  const setStatus = (i, text, cls) => { const el = $("status-" + i); if (el) { el.replaceChildren(text); el.style.color = cls ? `var(--${cls})` : ""; } };
  try {
    const signed = await state.wallet.features["solana:signTransaction"].signTransaction(
      ...state.plan.txs.map((t) => ({ account: state.account, transaction: b64ToBytes(t.tx), chain: "solana:mainnet" })));
    btn.textContent = "Sending…";
    const sigs = await api("/api/send", { txs: signed.map((s) => bytesToB64(s.signedTransaction)) });
    const pending = new Map();
    sigs.forEach((s, i) => typeof s === "string" ? (pending.set(i, s), setStatus(i, "Sent, confirming…")) : setStatus(i, "Failed to send: " + s.error, "bad"));
    for (let tries = 0; pending.size && tries < 40; tries++) {
      await new Promise((r) => setTimeout(r, 2000));
      const idx = [...pending.keys()];
      const st = await api("/api/status?sigs=" + idx.map((i) => pending.get(i)).join(","));
      st.forEach((s, k) => {
        const i = idx[k], sig = pending.get(i);
        if (!s) return;
        const link = h("a", { href: "https://solscan.io/tx/" + sig, target: "_blank", rel: "noreferrer" }, "view");
        if (s.err) { setStatus(i, ["Failed on-chain: " + JSON.stringify(s.err) + " · ", link], "bad"); pending.delete(i); }
        else if (s.status === "confirmed" || s.status === "finalized") { setStatus(i, ["Confirmed · ", link], "ok"); pending.delete(i); }
      });
    }
    if (pending.size) for (const i of pending.keys()) setStatus(i, "Not confirmed yet. Check your wallet history before retrying.", "warn");
    btn.textContent = "Done";
    await loadHoldings(true);
  } catch (e) {
    btn.disabled = false; btn.textContent = "Try again";
    $("plan").append(h("div", { class: "notice bad" }, e.message));
  }
}

function renderFeeFooter() {
  $("fee-footer").replaceChildren(...(state.fee ? [h("b", {}, "Fee. "),
    `A ${pct(state.fee.bps)} fee is taken from the minimum guaranteed output of each transaction. In that same transaction it buys $${burnToken().symbol} (`,
    h("span", { class: "mono" }, burnToken().id), ") and burns it. Nobody receives the fee, and every burn is visible on-chain. Swapping into ",
    burnToken().symbol + " has no fee."] : []));
}
api("/api/config").then((c) => { state.fee = c.fee; renderDefaults(); renderSummary(); renderFeeFooter(); })
  .catch(() => $("out-note").replaceChildren(h("div", { class: "notice bad" }, "Couldn't load fee settings. Any fee is still shown in the review before you sign.")));
renderDefaults(); renderWallet(); renderTokens();
