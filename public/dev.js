/* spacedust · dev/QA mode. NEVER SHIPS: listed in .vercelignore, and app.js only imports it on localhost/127.0.0.1
   with ?demo or ?watch=<address>.

   ?watch=<address>   A watch-only Wallet Standard wallet that "connects" as that address, so the real /api/holdings,
                      /api/plan and /api/refresh run against real data. It never signs: its signTransaction shows a
                      clearly labelled simulated prompt and hands the transactions back unsigned. /api/send and
                      /api/status are always answered from fixtures here, so nothing can reach the chain.
   ?demo              Everything from fixtures, plus a "states" popover that jumps to any scene or state, the
                      cleanup (rent reclaim) included. A few fixtures use real mints so /api/img shows real images.
   ?watch also reads the real /api/accounts and builds + simulates real /api/reclaim transactions.
   NFTs: the fixtures include NFT and collectible holdings (hidden from the list, one "left alone" line), one the
   server couldn't check (counted apart), a priced 0-decimal coin (a token, never burned), accounts still holding an
   NFT or collectible (never listed in the cleanup), empty NFT and collectible accounts (their own group) and a frozen
   empty NFT account (can't be closed). Real mints, so images are real.
   &outcome=success|partial|expired   send outcome for the simulation (also switchable in the simulated prompt)
   &fee=off           demo only: the no-fee deployment */

const BURN = "DBFcomeF97mTgRoKvHj2YtdFdvFcrLP4pFTBEPpKpump";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hash(str) { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
const fakeKey = (seed, len = 44) => { const r = rng(hash(seed)); let s = ""; for (let i = 0; i < len; i++) s += B58[Math.floor(r() * 58)]; return s; };
// fixture "transactions" with a real layout up to the blockhash (1 signature, v0 prefix, header, 2 keys,
// blockhash), so the app's signature and blockhash parsing behaves as it does with real ones
const randB64 = (n) => {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  b[0] = 1; b[65] = 0x80; b[66] = 1; b[67] = 0; b[68] = 1; b[69] = 2;
  return btoa(String.fromCharCode(...b));
};
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true });
});
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
class DevApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

/* ---------------- fixtures ---------------- */
const PRICES = { [SOL]: 152.4, [USDC]: 1, [USDT]: 1, [BURN]: 0.0000156 };
// real mainnet NFTs (as the server's classifier sees them), so /api/img shows their real pictures
const NFTS = {
  madlads: ["MAD", "Mad Lads", "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w", "pnft"],
  degod: ["DGOD", "DeGod #5142", "5F5wQHPxX2yLwuYEVFpBxu1oQzQWWxQyNHPaC7ZavxTb", "pnft"],
  citizen: ["DEMO", "Democracy Citizen #3748", "Gh4Sfru9a3vLnoag9wkygQykeBLV1VV7iywjqLSHTS4h", "nft"],
  burger: ["BURGER", "Burger #1946", "3LG6nFphb11cf4jeEU8bMuSXXpA18Ze9SWQNUcpfjQsg", "t22-nft"],
  saga: ["SAGAGEN", "Saga genesis token", "46pcSL5gmjBrPqGKFaLbbCmR6iVuLJbnQy13hAe7s6CC", "nft"],
  // collectibles: decimals 0, no NFT marker on-chain, no Jupiter price (Star Atlas ships and parts, an old airdrop)
  opaljet: ["OPALJ", "Opal Jet", "Ev3xUhc1Leqi4qR2E5VoG9pcxCvHHmnAaSRVPg485xAT", "collectible", 3],
  airbike: ["FMBA", "Fimbul Airbike", "Fw8PqtznYtg4swMk7Yjj89Tsj23u5CJLfW5Bk8ro4G1s", "collectible", 1],
  copper: ["CUORE", "Copper Ore", "CUore1tNkiubxSwDEtLc3Ybs1xfWLs8uGjyydUYZ25xc", "sft", 12100],
  core5: ["CORE5", "Core - Episode 5 (Magic Eden)", "8fGDD3bwfNvEy4ER7ttfpccbvRUADjqG53PEXfnT7CbW", "collectible", 1],
};
// what /api/holdings answers for an NFT or collectible: marked, never priced (the page drops it and counts it)
const NFT_ROW = (k) => { const [symbol, name, mint, kind, n = 1] = NFTS[k]; return { ...T(symbol, name, null, n, { mint }), nft: true, nftKind: kind }; };
// a decimals-0 mint the server couldn't read just now: left alone, but counted apart (never called an NFT)
const UNSURE_ROW = () => ({ ...T(null, null, null, 31, { mint: fakeKey("unsure0") }), nft: true, nftKind: "nft", nftUnsure: true });
// XCOPE: decimals 0 and no NFT marker, but Jupiter prices it, so it's a token (sellable; never burned)
const XCOPE = "3K6rftdAaQYMPunrtNRHgnK2UAtjm2JwyT2oCiTDouYE";
const T = (symbol, name, usd, amount, x = {}) => ({ mint: x.mint || fakeKey("m" + symbol + name), amount, frozen: !!x.frozen, usd, price: usd == null ? null : usd / amount, symbol, name, icon: x.icon ?? null, verified: !!x.verified, _loss: x.loss ?? 0.02, _skip: x.skip || null });
const HOLDINGS = {
  normal: () => [
    T("ALEIAH", "Aleiah", 1.0, 18402.11, { verified: true, loss: 0.012, mint: "24LebpSeoudMyGAt4wQ1J2gjJcAjCEMssQWtmyJvpump" }),
    T("Anon", "Anon", 0.99, 3120.5, { loss: 0.018, icon: "https://example.invalid/broken-icon.png" }),
    T("a/autism", "autism", 0.68, 912400, { loss: 0.026 }),
    T("ALLINU", "All Inu", 0.55, 41200000, { loss: 0.031 }),
    T("80085", "80085", 0.42, 80085, { loss: 0.022 }),
    T("MOTH", "Moth", 1.74, 96.2, { verified: true, loss: 0.007 }),
    T("FEEBUSY", "Fee Busy", 0.33, 1200, { skip: "buy-and-burn fee couldn't be routed right now; try again shortly" }),
    T("BOOP", "Boop", 0.09, 0.42, { verified: true, loss: 0.015 }),
    T("SANDY", "Sandy", 0.21, 5532, { skip: 'simulation failed: {"InstructionError":[3,{"Custom":1}]}' }),
    T("BIGROUTE", "Big Route", 0.61, 77, { skip: "route too large to fit in one transaction with its buy-and-burn" }),
    T("ALLCAT", "All Cat", 0.004, 1204000, { skip: "no route: /swap/v2/build 400: no route" }),
    T("ALLDOG", "All Dog", 0.002, 990000, { loss: 0.23 }),
    T("FRZN", "Frozen Thing", 0.3, 120, { frozen: true }),
    T("JUP", "Jupiter", 41.2, 58.1, { verified: true, loss: 0.004, mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }),
    T("LILVADER", "Lil Vader", 3.12, 200000, { verified: true, loss: 0.01, mint: BURN }),
    T("<b>FREE</b>", "Claim 5,000 USDC at fr33-usdc.xyz <img src=x onerror=alert(1)>", null, 5000),
    T("SPAM42", "spam", null, 1e9),
    { ...T(null, null, null, 1), mint: fakeKey("ghost") },
    T("XCOPE", "XCOPE", 0.33, 3, { mint: XCOPE, loss: 0.03 }),
    NFT_ROW("degod"), NFT_ROW("citizen"), NFT_ROW("burger"), NFT_ROW("opaljet"), NFT_ROW("copper"),
  ],
  // nothing but NFTs: "wallet's spotless", plus the left-alone line
  nfts: () => [NFT_ROW("madlads"), NFT_ROW("degod"), NFT_ROW("citizen"), NFT_ROW("burger"), NFT_ROW("saga")],
  // a game wallet: collectibles, one NFT, one mint that couldn't be checked, and a little real dust
  collectibles: () => [
    T("JUP", "Jupiter", 0.71, 1, { verified: true, mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }),
    NFT_ROW("opaljet"), NFT_ROW("airbike"), NFT_ROW("copper"), NFT_ROW("core5"), NFT_ROW("citizen"), UNSURE_ROW(),
  ],
  // only collectibles: the empty state says so before the line below the card
  collectiblesOnly: () => [NFT_ROW("opaljet"), NFT_ROW("airbike"), NFT_ROW("core5")],
  airdrop: () => {
    const r = rng(77), syl = ["PEP", "DOG", "CAT", "WIF", "MOON", "GM", "BRO", "SAD", "FROG", "MEME", "DUST", "GLIZ", "HAWK", "BUN", "ZAP", "PUFF", "RIZZ", "SNEK", "WOOF", "YETI"];
    return Array.from({ length: 38 }, (_, i) => {
      const s = syl[i % syl.length] + (i >= syl.length ? String(i - syl.length + 2) : "");
      return T(s, s.toLowerCase() + " token", +(0.02 + r() * 1.9).toFixed(2), Math.round(1000 + r() * 9e6), { loss: 0.004 + r() * 0.04, verified: r() > 0.8 });
    });
  },
  empty: () => [],
};
// the cleanup: every token account, empty ones included. Real mints where a real image helps the demo.
const RENT = 2039280, RENT22 = 2074080;
const AC = (symbol, name, x = {}) => {
  const rent = x.t22 ? RENT22 : RENT, amount = x.amount ? String(x.amount) : "0";
  const blocked = x.frozen ? "frozen" : x.foreign ? "close authority is someone else" : null;
  const closable = !blocked && (amount === "0" || !!x.native);
  return {
    address: fakeKey("acct" + symbol + name + (x.n ?? "")), mint: x.mint || fakeKey("m" + symbol + name), program: x.t22 ? "token-2022" : "token",
    amount, decimals: x.decimals ?? 6, uiAmount: x.ui ?? 0, frozen: !!x.frozen, native: !!x.native, rentLamports: rent, lamports: rent + (x.wrapped || 0),
    closeAuthority: x.foreign ? fakeKey("auth" + symbol) : null, closable,
    reason: blocked || (closable ? undefined : !x.nft ? "has balance" : x.nft === "sft" || x.nft === "collectible" ? "holds a collectible" : "holds an NFT"),
    // like the server: never NFTs, collectibles, other decimals-0 tokens or the burn token; priced only when the page asks with prices=1
    burnCandidate: !blocked && amount !== "0" && !x.native && !x.nft && (x.decimals ?? 6) > 0 && x.mint !== BURN, withheld: !!x.withheld,
    nft: !!x.nft, nftKind: x.nft ? x.nft : null,
    ...(x.unsure ? { nftUnsure: true } : {}), ...(x.nft === "collectible" ? { tokenIfPriced: true } : {}),
    symbol, name, verified: !!x.verified, _usd: x.usd ?? null, _skip: x.skip || null,
  };
};
// what /api/accounts answers: prices (and so "burnable") only with prices=1
const priced = (a, withPrices) => ({ ...a, usd: withPrices && a.burnCandidate ? a._usd : null, burnable: withPrices && a.burnCandidate && (a._usd == null || a._usd < 1) });
// an NFT account: holding the NFT (amount 1), or empty because the NFT already left (closable, its own group)
const ANFT = (k, x = {}) => { const [symbol, name, mint, kind] = NFTS[k]; return AC(symbol, name, { mint, decimals: 0, nft: kind, t22: kind === "t22-nft", ...x }); };
// a mint the server couldn't read just now (decimals 0): held ones are counted apart, empty ones close with the rest
const AUNSURE = (x = {}) => AC(null, null, { mint: fakeKey("unsure0"), decimals: 0, nft: "nft", unsure: true, ...x });
const EMPTY_SET = [
  ["BONK", "Bonk", { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", verified: true }],
  ["WIF", "dogwifhat", { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", verified: true }],
  ["USDC", "USD Coin", { mint: USDC, verified: true }],
  ["ALEIAH", "Aleiah", { mint: "24LebpSeoudMyGAt4wQ1J2gjJcAjCEMssQWtmyJvpump" }],
  ["PEPE2", "pepe two", {}], ["MOON", "moon token", {}], ["GLIZ", "glizzy", {}],
  ["HAWK", "hawk", { t22: true }], ["FEES", "Fee Token", { t22: true, withheld: true }], ["RIZZ", "rizz", {}],
  ["SNEK", "snek", { skip: "it still holds tokens" }], ["ZAP", "zap", {}],
  [null, null, {}], ["Visit claim-sol.app", "Claim 2 SOL at claim-sol.app", {}],
];
const ACCOUNTS = {
  normal: () => [
    AC("SOL", "Wrapped SOL", { native: true, amount: 12300000, ui: 0.0123, wrapped: 12300000, mint: SOL, verified: true }),
    ...EMPTY_SET.map(([s, n, x], i) => AC(s, n, { ...x, n: i })),
    AC("DEAD", "dead coin", { amount: 120000, ui: 120000 }),
    AC("TINY", "tiny", { amount: 5000, ui: 5000, usd: 0.04 }),
    AC("Free Airdrop", "Free airdrop at www.drop-xyz.top", { amount: 1e9, ui: 1000 }),
    AC("FRZN", "Frozen Thing", { frozen: true, amount: 120, ui: 120, usd: 0.3 }),
    AC("BOT", "bot account", { foreign: true }),
    AC("APE", "Lil Ape #4412", { amount: 1, ui: 1, decimals: 0, nft: "nft" }),
    ANFT("degod", { amount: 1, ui: 1, frozen: true }), // a pNFT's account is always frozen; still just "left alone"
    // decimals 0, no NFT marker: a collectible to the server, a token once the pockets list has its price; never burned
    AC("XCOPE", "XCOPE", { mint: XCOPE, amount: 3, ui: 3, decimals: 0, nft: "collectible" }),
    ANFT("opaljet", { amount: 3, ui: 3 }), ANFT("copper", { amount: 12100, ui: 12100 }),
    ANFT("madlads", { n: "e" }), ANFT("citizen", { n: "e" }), ANFT("burger", { n: "e" }), ANFT("core5", { n: "e" }),
    ANFT("saga", { n: "e", frozen: true }), // an empty NFT account its collection froze: can't be closed, still never "the token's"
    AUNSURE({ n: "e" }),
    AC("SPCX", "spacex dust", { amount: 870000, ui: 0.87, usd: 0.87 }),
    AC("JUP", "Jupiter", { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amount: 58100000, ui: 58.1, usd: 41.2, verified: true }),
    AC("LILVADER", "Lil Vader", { mint: BURN, amount: 2e11, ui: 200000, usd: 3.12, verified: true, t22: true }),
  ],
  many: () => [
    ...Array.from({ length: 130 }, (_, i) => AC(["PEP", "DOG", "CAT", "WIF", "GM", "BRO", "FROG", "MEME", "DUST", "BUN"][i % 10] + (i >= 10 ? i : ""), "coin " + i, { n: "m" + i })),
    AC("JUP", "Jupiter", { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amount: 58100000, ui: 58.1, usd: 41.2, verified: true }),
  ],
  blocked: () => [
    AC("BOT", "bot account", { foreign: true }),
    AC("FRZN", "Frozen Thing", { frozen: true }),
    AC("JUP", "Jupiter", { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amount: 58100000, ui: 58.1, usd: 41.2, verified: true }),
  ],
  // a collector: every account holds an NFT or used to
  nfts: () => [
    ANFT("degod", { amount: 1, ui: 1, frozen: true }), ANFT("citizen", { amount: 1, ui: 1 }), ANFT("burger", { amount: 1, ui: 1 }),
    ANFT("madlads", { n: "e" }), ANFT("saga", { n: "e" }),
  ],
  nftsHeldOnly: () => [ANFT("degod", { amount: 1, ui: 1, frozen: true }), ANFT("citizen", { amount: 1, ui: 1 })],
  // a game wallet: collectibles held and gone, one NFT, one account that couldn't be checked
  collectibles: () => [
    ANFT("opaljet", { amount: 3, ui: 3 }), ANFT("airbike", { amount: 1, ui: 1 }), ANFT("copper", { amount: 12100, ui: 12100 }),
    ANFT("citizen", { amount: 1, ui: 1 }), AUNSURE({ amount: 31, ui: 31 }),
    ANFT("core5", { n: "e" }), ANFT("madlads", { n: "e" }),
  ],
  none: () => [
    AC("JUP", "Jupiter", { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amount: 58100000, ui: 58.1, usd: 41.2, verified: true }),
    AC("MOTH", "Moth", { amount: 96200000, ui: 96.2, usd: 1.74, verified: true }),
  ],
};
const CATALOG = [
  { symbol: "JUP", name: "Jupiter", verified: true, usdPrice: 0.71 },
  { symbol: "BONK", name: "Bonk", verified: true, usdPrice: 0.000021 },
  { symbol: "WIF", name: "dogwifhat", verified: true, usdPrice: 1.92 },
  { symbol: "USDC", name: "USD Coin (bridged copy)", verified: false, usdPrice: 1 },
  { symbol: "SAND", name: "i hate sand", verified: false, usdPrice: null },
].map((t) => ({ ...t, id: fakeKey("cat" + t.symbol + t.name), icon: null, decimals: 6 }));

/* ---------------- styles for the dev-only UI (injected, so production CSS carries none of it) ---------------- */
const CSS = `
.dev-btn { display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 10px; border-radius:8px; color:#b7aed2; font:500 10px/1 Inter,system-ui,sans-serif; letter-spacing:.24em; text-transform:uppercase; box-shadow:inset 0 0 0 1px rgb(156 200 255 / .45); background:repeating-linear-gradient(-45deg, rgb(156 200 255 / .08) 0 6px, transparent 6px 12px); }
.dev-btn:hover { color:#fff; }
@media (max-width:640px) { .dev-btn { padding:0 7px; letter-spacing:.1em; } .dev-btn .dev-long { display:none; } }
.pop-demo { width:min(380px, calc(100vw - 24px)) !important; max-height:min(80dvh, 700px) !important; }
.demo-tag { font:500 9px/1 Inter,sans-serif; letter-spacing:.3em; text-transform:uppercase; color:#958bb4; padding:4px 6px; border-radius:5px; box-shadow:inset 0 0 0 1px rgb(149 139 180 / .3); }
.demo-group { margin-bottom:12px; } .demo-group .overline { margin-bottom:6px; }
.demo-items { display:flex; flex-wrap:wrap; gap:6px; }
.demo-items button, .demo-items a { height:32px; padding:0 10px; border-radius:8px; font-size:12.5px; color:#f2eee8; background:rgb(207 202 194 / .06); box-shadow:inset 0 0 0 1px rgb(207 202 194 / .12); display:inline-flex; align-items:center; text-decoration:none; }
.demo-items button:hover, .demo-items a:hover { background:rgb(207 202 194 / .14); }
.demo-items [aria-pressed="true"] { background:#deb25f; color:#1a1020; font-weight:600; }
#simWallet { position:fixed; inset:16px 16px auto auto; margin:0; width:min(350px, calc(100vw - 24px)); padding:0; border:0; border-radius:18px; overflow:hidden; background:#f4f3f7; color:#1b1a22; font:400 14px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif; box-shadow:0 30px 70px rgb(0 0 0 / .6), 0 0 0 1px rgb(0 0 0 / .2); }
#simWallet:not(:popover-open) { display:none; }
@media (max-width:640px) { #simWallet { inset:10px 10px auto 10px; width:auto; } }
.sim-top { display:flex; align-items:center; gap:10px; padding:12px 14px; background:#e7e5ee; font-size:12px; color:#55516a; }
.sim-top b { color:#1b1a22; font-size:13px; }
.sim-top .tag { margin-left:auto; font-size:10px; letter-spacing:.12em; text-transform:uppercase; padding:3px 6px; border-radius:5px; background:#ffd9a8; color:#5a3200; font-weight:700; }
.sim-body { padding:16px; }
.sim-body h3 { font-size:17px; margin:0 0 4px; font-weight:650; }
.sim-sub { font-size:12.5px; color:#66617a; margin:0 0 12px; }
.sim-warn { font-size:12px; color:#5a3200; background:#fff1dc; border-radius:10px; padding:8px 10px; margin:0 0 12px; }
.sim-changes { list-style:none; margin:0 0 12px; padding:10px 12px; border-radius:12px; background:#fff; box-shadow:0 0 0 1px #e3e0ea; max-height:180px; overflow:auto; font-size:13px; }
.sim-changes li { display:flex; justify-content:space-between; gap:10px; padding:3px 0; font-variant-numeric:tabular-nums; }
.sim-changes .neg { color:#c2362b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sim-changes .pos { color:#13804b; font-weight:600; }
.sim-changes .muted { color:#7a7590; }
.sim-label { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:#8a85a0; margin:0 0 6px; }
.sim-outcome { display:flex; gap:4px; margin:0 0 12px; padding:3px; border-radius:10px; background:#e7e5ee; }
.sim-outcome button { flex:1; height:30px; border-radius:8px; font:inherit; font-size:11.5px; color:#55516a; }
.sim-outcome button[aria-pressed="true"] { background:#fff; color:#1b1a22; font-weight:600; box-shadow:0 1px 2px rgb(0 0 0 / .12); }
.sim-btns { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.sim-btns button { height:44px; border-radius:12px; font:inherit; font-weight:600; font-size:14px; }
.sim-btns .rej { background:#e3e0ea; color:#1b1a22; } .sim-btns .ok { background:#1b1a22; color:#fff; }
#simWallet button:focus-visible { outline:2px solid #4b6bff; box-shadow:none; }
`;

export async function init(app, params) {
  const mode = params.has("demo") ? "demo" : "watch";
  const watchAddr = params.get("watch") || "";
  if (mode === "watch" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(watchAddr)) { console.warn("dev: ?watch needs a base58 address"); return null; }
  document.head.append(h("style", {}, CSS));

  const dev = {
    simulated: true,
    outcome: ["success", "partial", "expired"].includes(params.get("outcome")) ? params.get("outcome") : "success",
    holdings: "normal", accounts: "normal", planDelay: 1300, statusDelay: [900, 3600], autoApprove: null, hideWallets: false,
    sends: new Map(), // sig -> { fate, readyAt }
  };
  const feeOff = mode === "demo" && params.get("fee") === "off";
  const address = mode === "watch" ? watchAddr : fakeKey("demo-wallet");
  let pendingHoldings = null;

  /* ---- the dev wallet (Wallet Standard shape) ---- */
  const icon = "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#0e2a46"/><path d="M6 20s5-8 14-8 14 8 14 8-5 8-14 8S6 20 6 20z" fill="none" stroke="#9cc8ff" stroke-width="2.4"/><circle cx="20" cy="20" r="4.5" fill="#9cc8ff"/></svg>`);
  const account = { address, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signTransaction"], label: "dev" };
  const listeners = new Set();
  const wallet = {
    __dev: true, version: "1.0.0", name: mode === "watch" ? "Watch-only (dev)" : "Demo wallet (dev)", icon, chains: ["solana:mainnet"],
    get accounts() { return [account]; },
    features: {
      "standard:connect": { version: "1.0.0", connect: async (input) => { if (input?.silent && mode === "demo") return { accounts: [] }; await sleep(350); return { accounts: [account] }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
      "standard:events": { version: "1.0.0", on: (ev, fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: (...inputs) => simPrompt(inputs) },
    },
  };
  dev.walletFilter = (w) => !dev.hideWallets && !!w.__dev;
  app.registry.register(wallet);

  /* ---- simulated wallet prompt: deliberately looks like a different app, never signs ---- */
  const sim = h("div", { id: "simWallet", popover: "manual", role: "dialog", "aria-labelledby": "simTitle", "data-keep": "1" });
  document.body.append(sim);
  let simResolve = null;
  function closeSim(result) { try { sim.hidePopover(); } catch {} const r = simResolve; simResolve = null; r?.(result); }
  // if the app stops waiting (the "I closed it" button or Esc), the simulated prompt goes away too; its late
  // answer is ignored by the app either way
  new MutationObserver(() => { if (simResolve && !document.documentElement.classList.contains("cinema-on")) closeSim(false); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  function simPrompt(inputs) {
    return new Promise((resolve, reject) => {
      simResolve = (ok) => (ok ? resolve(inputs.map((i) => ({ signedTransaction: i.transaction }))) : reject(Object.assign(new Error("User rejected the request."), { code: 4001 })));
      const rcPlan = app.state.signing === "reclaim" ? app.state.rc.plan : null;
      const p = rcPlan ? null : app.state.plan, n = inputs.length, o = p?.out;
      const recv = (p?.txs || []).reduce((a, t) => a + t.legs.reduce((x, l) => x + l.outAmount, 0) - (t.fee?.amountIn || 0), 0);
      const rcBack = rcPlan ? rcPlan.txs.reduce((a, t) => a + t.lamports, 0) / 1e9 : 0;
      const rcBurns = rcPlan ? rcPlan.txs.flatMap((t) => t.accounts.filter((a) => a.action !== "close")) : [];
      const sym = (m) => app.state.rows.find((r) => r.mint === m)?.symbol || m.slice(0, 4) + "…";
      const outcomeBtns = [["success", "all confirm"], ["partial", "some fail"], ["expired", "all expire"]].map(([k, l]) =>
        h("button", { type: "button", "aria-pressed": String(dev.outcome === k), onclick: (e) => { dev.outcome = k; [...e.currentTarget.parentElement.children].forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); } }, l));
      sim.replaceChildren(
        h("div", { class: "sim-top" }, h("img", { src: icon, alt: "", width: "26", height: "26" }), h("b", { id: "simTitle" }, wallet.name), h("span", { class: "tag" }, "simulated · dev")),
        h("div", { class: "sim-body" },
          h("h3", {}, `Approve ${n} transaction${n === 1 ? "" : "s"}`),
          h("p", { class: "sim-sub" }, `${location.host} · estimated balance changes`),
          h("p", { class: "sim-warn" }, "Dev mode: nothing is signed. Approving hands the transactions back unsigned and the send and confirmations are simulated from fixtures. Nothing reaches the chain."),
          h("ul", { class: "sim-changes" },
            (p?.txs || []).flatMap((t) => t.legs.map((l) => h("li", {}, h("span", { class: "neg" }, `− ${sym(l.mint)}`), h("span", { class: "muted" }, "$" + l.usdIn.toFixed(2))))),
            rcPlan && h("li", {}, h("span", { class: "pos" }, `+${rcBack.toFixed(5)} SOL`), h("span", { class: "muted" }, "rent back")),
            rcPlan && h("li", {}, h("span", { class: "muted" }, `closes ${rcPlan.txs.reduce((a, t) => a + t.accounts.length, 0)} token accounts`), h("span", { class: "muted" }, "")),
            rcBurns.map((a) => h("li", {}, h("span", { class: "neg" }, `− ${a.symbol || a.mint.slice(0, 4) + "…"}`), h("span", { class: "muted" }, "burned"))),
            o && h("li", {}, h("span", { class: "pos" }, `+${recv.toPrecision(4)} ${o.symbol}`), h("span", { class: "muted" }, p.feeApplied ? "after fee" : "")),
            p?.feeApplied && h("li", {}, h("span", { class: "muted" }, "burn token"), h("span", { class: "muted" }, "+0 (bought & burned)"))),
          h("p", { class: "sim-label" }, "simulated outcome"),
          h("div", { class: "sim-outcome", role: "group", "aria-label": "Simulated outcome" }, outcomeBtns),
          h("div", { class: "sim-btns" }, h("button", { class: "rej", type: "button", onclick: () => closeSim(false) }, "Reject"), h("button", { class: "ok", type: "button", onclick: () => closeSim(true) }, "Approve (simulated)"))));
      const auto = dev.autoApprove; dev.autoApprove = null;
      setTimeout(() => {
        if (!simResolve) return;
        try { sim.showPopover(); sim.querySelector(".ok").focus({ preventScroll: true }); } catch {}
        if (auto) { dev.outcome = auto; setTimeout(() => closeSim(true), 700); }
      }, 450);
    });
  }

  /* ---- API fixtures ---- */
  dev.api = async (path, body, { signal } = {}) => {
    const url = new URL(path, location.origin);
    const route = url.pathname;
    if (route === "/api/send") return fakeSend(body);
    if (route === "/api/status") return fakeStatus(url);
    if (mode === "watch") return undefined; // everything else is real
    if (route === "/api/config") {
      await sleep(150);
      return feeOff ? { fee: null, prices: { [SOL]: PRICES[SOL], [USDC]: 1, [USDT]: 1 } } : { fee: { bps: 100, burnToken: { id: BURN, symbol: "LILVADER", name: "Lil Vader", icon: null, verified: true } }, prices: PRICES };
    }
    if (route === "/api/holdings") {
      if (dev.holdings === "slow") { await new Promise((r) => (pendingHoldings = r)); }
      await sleep(600, signal);
      if (dev.holdings === "error") throw new DevApiError("Spacedust is busy right now. Try again when the timer runs out.", 429);
      return (HOLDINGS[dev.holdings] || HOLDINGS.normal)().map(({ _loss, _skip, ...r }) => r);
    }
    if (route === "/api/tokens/search") {
      await sleep(220, signal);
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return CATALOG.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.id.toLowerCase().startsWith(q));
    }
    if (route === "/api/plan") return fakePlan(body, signal);
    if (route === "/api/accounts") {
      if (dev.accounts === "slow") await sleep(30_000, signal);
      await sleep(500, signal);
      if (dev.accounts === "error") throw new DevApiError("Spacedust is busy right now. Try again when the timer runs out.", 429);
      const withPrices = url.searchParams.get("prices") === "1";
      if (withPrices) await sleep(700, signal);
      return { accounts: (ACCOUNTS[dev.accounts] || ACCOUNTS.normal)().map((a) => priced(a, withPrices)).map(({ _skip, _usd, ...a }) => a), priced: withPrices, priceError: false };
    }
    if (route === "/api/reclaim") return fakeReclaim(body, signal);
    if (route === "/api/refresh") { await sleep(250, signal); return { txs: body.txs, lastValidBlockHeight: 1_000_000 }; }
    return undefined;
  };
  async function fakePlan(b, signal) {
    await sleep(dev.planDelay, signal);
    const outPrice = PRICES[b.outMint] ?? CATALOG.find((c) => c.id === b.outMint)?.usdPrice;
    if (!outPrice) throw new DevApiError("The token you're swapping into has no reliable price, so swaps can't be checked. Pick another.", 400);
    const feeApplied = !feeOff && b.outMint !== BURN;
    const all = [...HOLDINGS.normal(), ...HOLDINGS.airdrop(), ...HOLDINGS.nfts(), ...HOLDINGS.collectibles()];
    const skipped = [], txs = [];
    const maxLoss = Math.min(Math.max(Number(b.maxLossPct) || 0, 0), 50) / 100, slip = (b.slippageBps || 100) / 10_000;
    for (const mint of b.mints) {
      const r = all.find((x) => x.mint === mint);
      if (!r) { skipped.push({ mint, reason: "not in wallet" }); continue; }
      if (r.nft) { skipped.push({ mint, reason: r.nftUnsure ? "couldn't check whether it's an NFT right now; try again" : r.nftKind === "sft" || r.nftKind === "collectible" ? "collectibles aren't sold here" : "NFTs aren't sold here" }); continue; }
      if (r.frozen) { skipped.push({ mint, reason: "account frozen" }); continue; }
      if (r.usd == null) { skipped.push({ mint, reason: "no reliable price" }); continue; }
      if (r._skip) { skipped.push({ mint, reason: r._skip.startsWith("no route") ? "no route found" : r._skip }); continue; }
      if (dev.lowSol) { skipped.push({ mint, reason: "not enough SOL" }); continue; }
      const outUsd = r.usd * (1 - r._loss);
      if (outUsd < r.usd * (1 - maxLoss)) { skipped.push({ mint, reason: `route returns $${outUsd.toFixed(4)} for $${r.usd.toFixed(4)} (> ${Math.round(maxLoss * 100)}% loss)` }); continue; }
      const outAmount = outUsd / outPrice, minOut = outAmount * (1 - slip);
      const fee = feeApplied ? { amountIn: minOut * 0.01, usd: minOut * 0.01 * outPrice, burned: (minOut * 0.01 * outPrice) / PRICES[BURN] } : null;
      txs.push({ tx: randB64(420), bytes: 420, legs: [{ mint, usdIn: r.usd, outAmount, minOut }], fee });
    }
    // the server adds the wallet's SOL balance only when something was skipped for lack of SOL
    return { skipped, feeApplied, burnMint: feeApplied ? BURN : null, outPrice, txs, ...(dev.lowSol ? { solLamports: 1_174_211 } : {}) };
  }
  // about 20 closes per "transaction", like the real packing; fixtures marked _skip are skipped with that reason
  async function fakeReclaim(b, signal) {
    await sleep(dev.planDelay, signal);
    const all = [...ACCOUNTS.normal(), ...ACCOUNTS.many(), ...ACCOUNTS.none(), ...ACCOUNTS.nfts(), ...ACCOUNTS.collectibles()];
    const skipped = [], ok = [];
    for (const [addr, burn] of [...(b.close || []).map((a) => [a, false]), ...(b.burn || []).map((a) => [a, true])]) {
      const a = all.find((x) => x.address === addr);
      if (!a) skipped.push({ address: addr, reason: "not a token account (already closed?)" });
      else if (a._skip) skipped.push({ address: addr, reason: a._skip });
      else if (!burn && !a.closable) skipped.push({ address: addr, reason: a.reason || "it still holds tokens" });
      else if (burn && a.amount !== "0" && !a.burnCandidate) skipped.push({ address: addr, reason: a.nft && (a.nftKind === "sft" || a.nftKind === "collectible") && !a.nftUnsure ? "it's a collectible, and collectibles are never burned here" : a.nft ? "it's an NFT, and NFTs are never burned here" : a.decimals === 0 ? "it has no decimals, so its value can't be told; it's never burned here" : "that's the burn token; keep it or sell it instead" });
      else if (burn && a._usd != null && a._usd >= 1) skipped.push({ address: addr, reason: `worth about $${a._usd.toFixed(2)}, so it's not burned; sell it instead` });
      else ok.push({ address: a.address, mint: a.mint, action: burn ? "burn+close" : "close", rentLamports: a.rentLamports, lamports: a.lamports, native: a.native, uiAmount: a.uiAmount });
    }
    const txs = [];
    for (let i = 0; i < ok.length; i += 20) {
      const accounts = ok.slice(i, i + 20);
      txs.push({ tx: randB64(900), bytes: 900 + accounts.length * 10, accounts, rentLamports: accounts.reduce((s, a) => s + a.rentLamports, 0), lamports: accounts.reduce((s, a) => s + a.lamports, 0), feeLamports: 5_200 });
    }
    return { txs, skipped, blockhash: "fixture", lastValidBlockHeight: 1_000_000, cuPrice: 50_000 };
  }
  function fakeSend(b) {
    const n = b.txs.length, now = Date.now();
    return b.txs.map((_, i) => {
      const fate = dev.outcome === "expired" ? "expired" : dev.outcome === "partial" && n > 1 && i === n - 1 ? "expired" : dev.outcome === "partial" && i === Math.max(0, n - 2) ? "failed" : "confirmed";
      const sig = fakeKey("sig" + now + i + Math.random(), 88);
      const [a, z] = dev.statusDelay;
      dev.sends.set(sig, { fate, readyAt: now + a + Math.random() * (z - a), expireAt: now + z + 2500 });
      return sig;
    });
  }
  async function fakeStatus(url) {
    await sleep(120);
    const sigs = (url.searchParams.get("sigs") || "").split(",").filter(Boolean), now = Date.now();
    let expired = false;
    const statuses = sigs.map((s) => {
      const e = dev.sends.get(s);
      if (!e) return null;
      if (e.fate === "expired") { if (now > e.expireAt) expired = true; return null; }
      if (now < e.readyAt) return null;
      return e.fate === "failed" ? { status: "confirmed", err: { InstructionError: [3, { Custom: 6001 }] } } : { status: "confirmed", err: null };
    });
    return url.searchParams.get("h") === "1" ? { statuses, blockHeight: expired ? Number.MAX_SAFE_INTEGER : 0 } : statuses;
  }

  /* ---- badge + states popover ---- */
  const btn = h("button", { class: "dev-btn", type: "button", popovertarget: "demoPop", "aria-label": mode === "demo" ? "Dev: jump to a state" : "Dev: watch-only mode" },
    h("span", {}, "dev"), h("span", { class: "dev-long" }, mode === "demo" ? " · states" : " · watch-only"));
  document.getElementById("barRight").prepend(btn);
  const pop = h("div", { popover: "", id: "demoPop", class: "pop pop-demo", role: "dialog", "aria-label": "Dev states" });
  document.body.append(pop);

  async function reset() {
    const s = app.state;
    s.epoch++;
    s.building?.ctrl?.abort();
    pendingHoldings?.(); pendingHoldings = null;
    closeSim(false);
    app.closeAllPops(); app.clearToasts(); app.hideCinema(true); app.stopRing();
    const d = document.getElementById("walletDlg"); if (d.open) d.close();
    s.rc?.building?.ctrl?.abort();
    s.rc = app.rcFresh(); s.signing = null; s.intent = null;
    s.busy = null; s.building = null; s.connecting = false; s.connectingSilent = false; s.plan = null; s.run = null; s.stale = false; s.staleWhy = null; s.notice = null; s.pendingAccounts = null; s.tempLoss = null;
    document.getElementById("main").inert = false;
    dev.hideWallets = false; dev.lowSol = false; dev.planDelay = 1300; dev.statusDelay = [900, 3600]; dev.autoApprove = null; dev.accounts = "normal";
    s.out = app.DEFAULT_OUTS[0]; s.customAck = false; s.includeBurn = false; s.query = ""; document.getElementById("listSearch").value = "";
    s.preset = 2; s.range = { min: 0, max: 2 };
  }
  async function landing() {
    await reset();
    if (app.state.account) app.disconnect({ quiet: true }); else { document.documentElement.classList.add("revisit"); await app.go("title"); app.renderBar(); }
  }
  async function connected(kind = "normal") {
    await reset();
    dev.holdings = kind;
    if (app.state.account) { await app.go("pockets"); app.loadHoldings(); }
    else await app.connect(wallet);
    if (kind !== "slow") await waitFor(() => !app.state.loading);
  }
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(60); };
  async function review(opts = {}) {
    await connected("normal");
    if (opts.lilvader && app.burnOut()) app.setOut(app.burnOut());
    dev.planDelay = 150;
    await app.startPreview();
  }
  async function finished(outcome) {
    await review();
    dev.statusDelay = [300, 900];
    dev.autoApprove = outcome;
    app.approve();
  }
  async function cleanup(kind = "normal") {
    await reset();
    dev.accounts = kind;
    if (app.state.account) app.openCleanup();
    else { app.state.intent = "cleanup"; await app.connect(wallet); }
    if (kind !== "slow") await waitFor(() => !app.state.rc.loading && !!(app.state.rc.accounts || app.state.rc.error));
  }
  async function rcReview({ burns = false, kind = "normal" } = {}) {
    await cleanup(kind);
    const rc = app.state.rc;
    if (burns) {
      await app.loadAccounts({ silent: true, prices: true });
      rc.burnAck = true; rc.burnOpen = true; rc.built = null;
      rc.burnSel = new Set(rc.accounts.filter((a) => a.burnable && a.usd != null).slice(0, 2).map((a) => a.address));
      app.renderCleanup();
    }
    dev.planDelay = 200;
    await app.buildReclaim();
  }
  async function rcFinished(outcome) {
    await rcReview({ kind: outcome === "partial" ? "many" : "normal" });
    dev.statusDelay = [300, 900];
    dev.autoApprove = outcome;
    app.approveReclaim();
  }
  const STATES = [
    ["flow", [
      ["landing", landing],
      ["wallet picker", async () => { await landing(); app.openWallets(); }],
      ["loading", () => connected("slow")],
      ["list", () => connected("normal")],
      ["output picker", async () => { await connected("normal"); app.openPop("outPop", document.getElementById("outChip")); }],
      ["options", async () => { await connected("normal"); app.openPop("setPop", document.getElementById("setBtn")); }],
      ["building", async () => { await connected("normal"); dev.planDelay = 4000; app.startPreview(); }],
      ["review", () => review()],
      ["quotes expired", async () => { await review(); app.state.planAt = Date.now() - app.TTL_MS - 1000; app.renderRing(); }],
      ["waiting for wallet", async () => { await review(); app.approve(); }],
      ["sending", async () => { await review(); dev.statusDelay = [25000, 40000]; dev.autoApprove = "success"; app.approve(); }],
      ["success", () => finished("success")],
      ["partial failure", () => finished("partial")],
      ["expired", () => finished("expired")],
    ]],
    ["edge cases", [
      ["no wallet found", async () => { await landing(); dev.hideWallets = true; app.state.booted = true; app.openWallets(); }],
      ["empty wallet", () => connected("empty")],
      ["only NFTs", () => connected("nfts")],
      ["NFTs, collectibles, unchecked", () => connected("collectibles")],
      ["only collectibles", () => connected("collectiblesOnly")],
      ["holdings error", () => connected("error")],
      ["error toast", async () => { await connected("normal"); app.toast({ title: "the server timed out", body: "Try fewer tokens at once. Nothing was signed or sent.", tone: "bad", actions: [{ label: "try again", run: () => app.startPreview() }] }); }],
      ["30+ tokens", () => connected("airdrop")],
      ["over the limit", async () => { await connected("airdrop"); const s = app.state; s.selected = new Set(s.rows.filter((r) => r.usd != null).map((r) => r.mint)); app.syncRows(); app.renderPocketsMeta(); app.renderAside(); app.renderBar(); }],
      ["short on SOL", async () => { await connected("normal"); dev.lowSol = true; dev.planDelay = 150; await app.startPreview(); }],
      ["into $LILVADER, no fee", async () => { await connected("normal"); if (app.burnOut()) app.setOut(app.burnOut()); }],
      ["review into $LILVADER", () => review({ lilvader: true })],
      ["unverified output", async () => { await connected("normal"); app.setOut({ ...CATALOG[3] }); }],
    ]],
    ["the cleanup", [
      ["cleanup list", () => cleanup("normal")],
      ["cleanup: nothing to close", () => cleanup("none")],
      ["cleanup: can't close any", () => cleanup("blocked")],
      ["cleanup: NFT collector", () => cleanup("nfts")],
      ["cleanup: only held NFTs", () => cleanup("nftsHeldOnly")],
      ["cleanup: game wallet (collectibles)", () => cleanup("collectibles")],
      ["cleanup: big wallet", () => cleanup("many")],
      ["cleanup: burn section open", async () => { await cleanup("normal"); const rc = app.state.rc; rc.burnOpen = true; rc.built = null; app.renderCleanup(); }],
      ["cleanup loading", () => cleanup("slow")],
      ["cleanup error", () => cleanup("error")],
      ["cleanup building", async () => { await cleanup("normal"); dev.planDelay = 8000; app.buildReclaim(); }],
      ["cleanup review", () => rcReview()],
      ["review with burns", () => rcReview({ burns: true })],
      ["cleanup success", () => rcFinished("success")],
      ["cleanup partial", () => rcFinished("partial")],
      ["empty wallet + rent", async () => { await connected("empty"); }],
    ]],
  ];
  function renderPop() {
    const here = new URL(location.href);
    const link = (label, mutate) => { const u = new URL(here); mutate(u.searchParams); return h("a", { href: u.pathname + u.search }, label); };
    pop.replaceChildren(...[
      h("p", { class: "pop-title" }, "jump to a state ", h("span", { class: "demo-tag" }, mode)),
      mode === "demo" ? STATES.map(([group, items]) => h("div", { class: "demo-group" }, h("p", { class: "overline" }, group),
        h("div", { class: "demo-items" }, items.map(([label, run]) => h("button", { type: "button", onclick: () => { app.closePop("demoPop"); run(); } }, label)))))
        : h("p", { class: "hint", style: "margin-bottom:12px" }, `Watching ${address.slice(0, 4)}…${address.slice(-4)} with real holdings, quotes and refresh. Signing and sending are simulated.`),
      h("div", { class: "demo-group" }, h("p", { class: "overline" }, "simulated send outcome"), h("div", { class: "demo-items" },
        ["success", "partial", "expired"].map((k) => h("button", { type: "button", "aria-pressed": String(dev.outcome === k), onclick: () => { dev.outcome = k; renderPop(); } }, k)))),
      h("div", { class: "demo-group" }, h("p", { class: "overline" }, "toggles"), h("div", { class: "demo-items" },
        h("button", { type: "button", "aria-pressed": String(document.documentElement.dataset.motion === "off"), onclick: () => { const r = document.documentElement; r.dataset.motion = r.dataset.motion === "off" ? "" : "off"; r.classList.toggle("rm", r.dataset.motion === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches); renderPop(); } }, "reduced motion"),
        mode === "demo" && link(feeOff ? "fee config on" : "fee config off", (sp) => (feeOff ? sp.delete("fee") : sp.set("fee", "off"))))),
      h("p", { class: "hint" }, "Dev only. This file never ships, and nothing here can sign or send a transaction.")].flat().filter(Boolean));
  }
  pop.addEventListener("beforetoggle", (e) => { if (e.newState === "open") { renderPop(); app.placePopover(pop, btn); requestAnimationFrame(() => app.placePopover(pop, btn)); } });
  return dev;
}
