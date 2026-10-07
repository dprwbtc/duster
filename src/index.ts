import fs from "node:fs";
import os from "node:os";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getPrices } from "./jupiter.js";
import { getHoldings } from "./wallet.js";
import { planSwaps } from "./plan.js";
import { classifyMints, hintsFrom } from "./nft.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const { values: a } = parseArgs({
  options: {
    to: { type: "string", default: SOL }, // output mint (SOL by default; USDC = EPjF...)
    "max-usd": { type: "string", default: "2" }, // only swap tokens worth <= this
    "min-usd": { type: "string", default: "0" },
    slippage: { type: "string", default: "100" }, // bps
    "max-loss-pct": { type: "string", default: "10" }, // skip routes losing more than this vs. oracle price
    "max-accounts": { type: "string", default: "64" }, // largest route to try per swap; tighter routes are tried if a tx is too big
    exclude: { type: "string", default: "" }, // comma-separated mints to leave alone
    only: { type: "string", default: "" }, // comma-separated mints to swap exclusively
    "no-close": { type: "boolean", default: false }, // keep emptied token accounts
    owner: { type: "string" }, // dry-run as this wallet (public address only, no keypair; can't --execute)
    "fee-mint": { type: "string", default: process.env.BURN_TOKEN_MINT ?? "" }, // mirror the website's buy-and-burn fee
    "fee-bps": { type: "string", default: process.env.FEE_BPS ?? "100" },
    execute: { type: "boolean", default: false }, // without this it's a dry run
    yes: { type: "boolean", default: false }, // skip confirmation prompt
    help: { type: "boolean", default: false },
  },
});

if (a.help) {
  console.log(`Usage: npm start -- [--to <mint>] [--max-usd 2] [--exclude m1,m2] [--execute]
Dry-run by default: lists dust, builds and simulates transactions. Add --execute to send.
  --owner <address>   dry-run as any wallet (no keypair needed): plans and simulates exactly like the website
  --fee-mint <mint>   include the website's buy-and-burn fee (defaults to $BURN_TOKEN_MINT), --fee-bps 100`);
  process.exit(0);
}

const need = (k: string) => process.env[k] ?? (console.error(`Missing env ${k} (see .env.example)`), process.exit(1));
const apiKey = process.env.JUPITER_API_KEY ?? ""; // Jupiter allows low-volume keyless use
const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
if (a.owner && a.execute) (console.error("--owner is dry-run only; use KEYPAIR_PATH to execute"), process.exit(1));
const payer = a.owner ? null : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(need("KEYPAIR_PATH").replace(/^~/, os.homedir()), "utf8"))));
const ownerKey = payer?.publicKey ?? new PublicKey(a.owner!);
const connection = new Connection(rpc, "confirmed");
const fee = a["fee-mint"] ? { bps: Number(a["fee-bps"]), burnMint: new PublicKey(a["fee-mint"]).toBase58(), slippageBps: 300 } : null;

const maxUsd = Number(a["max-usd"]);
const minUsd = Number(a["min-usd"]);
const maxLoss = Number(a["max-loss-pct"]) / 100;
const closeSource = !a["no-close"];
const outMint = a.to!;
const exclude = new Set(a.exclude!.split(",").filter(Boolean));
const only = new Set(a.only!.split(",").filter(Boolean));
const skipped: { mint: string; reason: string }[] = [];

console.log(`Wallet ${ownerKey.toBase58()}  →  ${outMint}  (${a.execute ? "LIVE" : "dry run"})${fee ? `  fee ${fee.bps} bps buys & burns ${fee.burnMint}` : ""}`);

// 1. Find dust: priced tokens worth between min-usd and max-usd.
// The burn token is never sold for the fee (the website hides it too).
// NFTs (and SFTs, editions, pNFTs) are never sold, like on the website: classified on-chain and left alone. A
// decimals-0 collectible with no NFT marker is a token only if Jupiter prices it (checked below with the rest).
const all = (await getHoldings(connection, ownerKey)).filter((h) => h.mint !== outMint && h.mint !== SOL && h.mint !== fee?.burnMint);
const nfts = await classifyMints(connection, all.map((h) => h.mint), hintsFrom(all));
const maybeTokens = all.filter((h) => { const c = nfts.get(h.mint); return !!c && (!c.nft || !!c.tokenIfPriced); });
const prices = await getPrices(apiKey, [...new Set([...maybeTokens.map((h) => h.mint), outMint])]);
const holdings = maybeTokens.filter((h) => !nfts.get(h.mint)!.nft || typeof prices[h.mint]?.usdPrice === "number");
if (holdings.length < all.length) console.log(`${all.length - holdings.length} NFT(s) and collectible(s) in this wallet are left alone.`);
const outInfo = prices[outMint];
if (!outInfo) throw new Error("No price for output token; can't sanity-check swaps");

const candidates: { h: (typeof holdings)[number]; usd: number }[] = [];
for (const h of holdings) {
  const p = prices[h.mint];
  if (exclude.has(h.mint)) continue;
  if (only.size && !only.has(h.mint)) continue;
  if (h.frozen) skipped.push({ mint: h.mint, reason: "account frozen" });
  else if (!p || typeof p.usdPrice !== "number") skipped.push({ mint: h.mint, reason: "no reliable price (left alone)" }); // Jupiter may list a mint without a price
  else if (h.uiAmount * p.usdPrice > maxUsd) continue; // not dust
  else if (h.uiAmount * p.usdPrice < minUsd) skipped.push({ mint: h.mint, reason: "below --min-usd" });
  else candidates.push({ h, usd: h.uiAmount * p.usdPrice });
}
console.log(`\n${candidates.length} dust token(s) ≤ $${maxUsd}:`);
for (const c of candidates) console.log(`  ${c.h.mint}  ${c.h.uiAmount}  ≈ $${c.usd.toFixed(4)}`);

// 2-3. Quote, one transaction per token, simulate, drop tokens that fail.
const { batches, skipped: planSkipped } = await planSwaps({
  connection,
  apiKey,
  owner: ownerKey,
  outMint,
  outInfo,
  items: candidates,
  slippageBps: Number(a.slippage),
  maxAccounts: Number(a["max-accounts"]),
  maxLoss,
  closeSource,
  fee,
});
skipped.push(...planSkipped);

console.log(`\nPlan: ${batches.length} transaction(s)`);
batches.forEach((b, i) => {
  const usd = b.legs.reduce((s, l) => s + l.usdIn, 0);
  const f = b.fee ? `, fee ${b.fee.amountIn} -> burns ≥ ${Number(b.fee.burn.amount) / 10 ** b.fee.burn.decimals}` : "";
  console.log(`  tx ${i + 1}: ${b.legs.map((l) => l.holding.mint.slice(0, 6)).join(",")} ≈ $${usd.toFixed(2)}, ${b.tx.serialize().length} bytes${f}`);
});
if (skipped.length) {
  console.log("\nSkipped:");
  for (const s of skipped) console.log(`  ${s.mint}: ${s.reason}`);
}
if (!batches.length || !payer) process.exit(0);
if (!a.execute) {
  console.log("\nDry run only (all transactions simulated OK). Re-run with --execute to send.");
  process.exit(0);
}

// 4. Confirm, then send.
if (!a.yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`\nSend ${batches.length} transaction(s)? [y/N] `);
  rl.close();
  if (ans.trim().toLowerCase() !== "y") process.exit(0);
}
for (const b of batches) {
  // Blockhashes last ~60-90s; if you sat on the prompt, this fails preflight and you can just re-run.
  b.tx.sign([payer]);
  const sig = await connection.sendRawTransaction(b.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log(`sent ${sig}`);
  const res = await connection.confirmTransaction({ signature: sig, blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight }, "confirmed");
  console.log(res.value.err ? `  FAILED: ${JSON.stringify(res.value.err)}` : `  confirmed: https://solscan.io/tx/${sig}`);
}
