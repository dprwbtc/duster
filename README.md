# bulk-swap

Swap many dust tokens into one asset (SOL by default) using Jupiter Swap V2 `/build`,
packing as many swaps as fit into each transaction.

```bash
cp .env.example .env   # fill in JUPITER_API_KEY, RPC_URL, KEYPAIR_PATH
set -a; . ./.env; set +a
npm start                      # dry run: list dust, build + simulate
npm start -- --execute         # send (asks to confirm)
npm start -- --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --max-usd 5 --exclude <mint>
```

Flags: `--to`, `--max-usd`, `--min-usd`, `--slippage` (bps), `--max-loss-pct`, `--max-accounts`,
`--exclude`, `--only`, `--no-close`, `--execute`, `--yes`.

Notes
- A Solana tx is limited to 1232 bytes, so "one transaction" means *as few as fit* (usually several swaps each).
- Tokens with no reliable Jupiter price are never touched. Routes losing >`--max-loss-pct` vs. oracle price are skipped.
- Emptied source token accounts are closed to reclaim rent unless `--no-close`.
- Each tx is simulated; if one fails, the batch is bisected so a single bad token doesn't block the rest.

## Web UI

```bash
npm run web      # then open http://localhost:3000
```

Needs only `JUPITER_API_KEY` (and optionally `RPC_URL`); **no private key**. Connect Phantom, Solflare or
Backpack, pick the output token (SOL/USDC/USDT, or search / paste any mint), set the value filter, tick the
tokens you want, preview, then approve in your wallet. The server binds to 127.0.0.1 only and keeps your
Jupiter key server-side.
