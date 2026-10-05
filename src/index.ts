import fs from "node:fs";
import os from "node:os";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { Connection, Keypair } from "@solana/web3.js";
import { getBuild, getPrices } from "./jupiter.js";
import { getHoldings } from "./wallet.js";
import { finalize, groupBySize, type SwapLeg } from "./pack.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const { values: a } = parseArgs({
  options: {
    to: { type: "string", default: SOL }, // output mint (SOL by default; USDC = EPjF...)
    "max-usd": { type: "string", default: "2" }, // only swap tokens worth <= this
    "min-usd": { type: "string", default: "0" },
    slippage: { type: "string", default: "100" }, // bps
    "max-loss-pct": { type: "string", default: "10" }, // skip routes losing more than this vs. oracle price
    "max-accounts": { type: "string", default: "20" }, // smaller routes => more swaps per tx
    exclude: { type: "string", default: "" }, // comma-separated mints to leave alone
    only: { type: "string", default: "" }, // comma-separated mints to swap exclusively
    "no-close": { type: "boolean", default: false }, // keep emptied token accounts
    execute: { type: "boolean", default: false }, // without this it's a dry run
    yes: { type: "boolean", default: false }, // skip confirmation prompt
    help: { type: "boolean", default: false },
  },
});

if (a.help) {
  console.log(`Usage: npm start -- [--to <mint>] [--max-usd 2] [--exclude m1,m2] [--execute]
Dry-run by default: lists dust, builds and simulates transactions. Add --execute to send.`);
  process.exit(0);
}

const need = (k: string) => process.env[k] ?? (console.error(`Missing env ${k} (see .env.example)`), process.exit(1));
const apiKey = need("JUPITER_API_KEY");
const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const keypairPath = need("KEYPAIR_PATH").replace(/^~/, os.homedir());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
const connection = new Connection(rpc, "confirmed");

const maxUsd = Number(a["max-usd"]);
const minUsd = Number(a["min-usd"]);
const maxLoss = Number(a["max-loss-pct"]) / 100;
const closeSource = !a["no-close"];
const outMint = a.to!;
const exclude = new Set(a.exclude!.split(",").filter(Boolean));
const only = new Set(a.only!.split(",").filter(Boolean));
const skipped: { mint: string; reason: string }[] = [];

console.log(`Wallet ${payer.publicKey.toBase58()}  →  ${outMint}  (${a.execute ? "LIVE" : "dry run"})`);

// 1. Find dust: priced tokens worth between min-usd and max-usd.
const holdings = (await getHoldings(connection, payer.publicKey)).filter((h) => h.mint !== outMint && h.mint !== SOL);
const prices = await getPrices(apiKey, [...new Set([...holdings.map((h) => h.mint), outMint])]);
const outInfo = prices[outMint];
if (!outInfo) throw new Error("No price for output token; can't sanity-check swaps");

const candidates: { h: (typeof holdings)[number]; usd: number }[] = [];
for (const h of holdings) {
  const p = prices[h.mint];
  if (exclude.has(h.mint)) continue;
  if (only.size && !only.has(h.mint)) continue;
  if (h.frozen) skipped.push({ mint: h.mint, reason: "account frozen" });
  else if (!p) skipped.push({ mint: h.mint, reason: "no reliable price (left alone)" });
  else if (h.uiAmount * p.usdPrice > maxUsd) continue; // not dust
  else if (h.uiAmount * p.usdPrice < minUsd) skipped.push({ mint: h.mint, reason: "below --min-usd" });
  else candidates.push({ h, usd: h.uiAmount * p.usdPrice });
}
console.log(`\n${candidates.length} dust token(s) ≤ $${maxUsd}:`);
for (const c of candidates) console.log(`  ${c.h.mint}  ${c.h.uiAmount}  ≈ $${c.usd.toFixed(4)}`);

// 2. Fetch swap instructions for each (a few at a time to respect rate limits).
const legs: SwapLeg[] = [];
const queue = [...candidates];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let c; (c = queue.shift()); ) {
      try {
        const build = await getBuild(apiKey, {
          inputMint: c.h.mint,
          outputMint: outMint,
          amount: c.h.rawAmount.toString(),
          taker: payer.publicKey.toBase58(),
          slippageBps: Number(a.slippage),
          maxAccounts: Number(a["max-accounts"]),
        });
        const outUsd = (Number(build.outAmount) / 10 ** outInfo.decimals) * outInfo.usdPrice;
        if (outUsd < c.usd * (1 - maxLoss)) {
          skipped.push({ mint: c.h.mint, reason: `route returns $${outUsd.toFixed(4)} for $${c.usd.toFixed(4)} (> ${a["max-loss-pct"]}% loss)` });
          continue;
        }
        legs.push({ holding: c.h, build, usdIn: c.usd });
      } catch (e) {
        skipped.push({ mint: c.h.mint, reason: `no route: ${(e as Error).message.slice(0, 120)}` });
      }
    }
  }),
);

// 3. Pack into as few transactions as fit, simulate each, drop tokens that fail.
const batches = (await Promise.all(
  groupBySize(payer.publicKey, legs, closeSource).map((g) => finalize(connection, payer, g, closeSource, skipped)),
)).flat();

console.log(`\nPlan: ${batches.length} transaction(s)`);
batches.forEach((b, i) => {
  const usd = b.legs.reduce((s, l) => s + l.usdIn, 0);
  console.log(`  tx ${i + 1}: ${b.legs.length} swaps, ≈ $${usd.toFixed(2)}, ${b.tx.serialize().length} bytes`);
});
if (skipped.length) {
  console.log("\nSkipped:");
  for (const s of skipped) console.log(`  ${s.mint}: ${s.reason}`);
}
if (!batches.length) process.exit(0);
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
  const sig = await connection.sendRawTransaction(b.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log(`sent ${sig}`);
  const res = await connection.confirmTransaction({ signature: sig, blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight }, "confirmed");
  console.log(res.value.err ? `  FAILED: ${JSON.stringify(res.value.err)}` : `  confirmed: https://solscan.io/tx/${sig}`);
}
