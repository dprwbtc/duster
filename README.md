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

## Web UI (local)

```bash
npm run web      # then open http://localhost:3000
```

Needs only `JUPITER_API_KEY` (and ideally `RPC_URL`). No private key: users connect Phantom, Solflare or
Backpack and sign in their wallet. The local server runs the same handlers and security headers as Vercel.

## Deploying to Vercel

Layout: `public/` is the static site, `api/*.ts` are Vercel Functions, `src/` is shared code.

1. **Import the repo** in Vercel → *New Project*. Set **Root Directory** to `bulk-swap` and the framework
   preset to **Other**. `vercel.json` handles the rest.
2. **Environment variables** (Production and Preview):
   - `JUPITER_API_KEY`: from https://developers.jup.ag/portal. Every visitor's requests use your quota,
     so check which plan's rate limits you need.
   - `RPC_URL`: **required in production.** Use a paid RPC (Helius, Triton, QuickNode, …). The public
     endpoint rate-limits hard and blocks the token-account lookups this app needs.
   Both stay server-side and are never sent to the browser.
3. **Add a rate limit** so nobody can drain your Jupiter/RPC quota: Project → *Firewall* → *Add rule*:
   if Request Path starts with `/api`, rate limit to 60 requests per 60s per IP. Or with the CLI:
   ```bash
   vercel firewall rules add "API rate limit" \
     --condition '{"type":"path","op":"pre","value":"/api"}' \
     --action rate_limit --rate-limit-window 60 --rate-limit-requests 60 \
     --rate-limit-keys ip --rate-limit-action rate_limit --yes
   ```
   The handlers also have a per-instance limiter, but that's only a backstop.
4. **Set a spend limit** under Team Settings → Billing, so a traffic spike can't surprise you.
5. **Test on the preview deployment** with a wallet holding a few dollars of dust before sharing the link.

### What protects users

- Non-custodial: the server only builds **unsigned** transactions. The user's wallet signs, and shows the
  balance changes before approval.
- The server re-reads balances and prices itself and ignores amounts sent by the browser. It skips tokens with no
  reliable price and routes that lose more than the user's limit (capped at 50%). Slippage is capped at 20%.
- Every transaction is simulated before it's offered for signing. A plan older than 45s is rebuilt before
  signing.
- Strict Content-Security-Policy (scripts only from this site), `frame-ancestors 'none'` against
  clickjacking. Token names are rendered as text, never HTML.
- Input validation and size caps on every endpoint (30 tokens per plan, 10 transactions per send). `/api/send`
  only relays fully signed, well-formed transactions. Errors are returned to the browser as generic messages.

### What's still on you

- Your Jupiter and RPC plans need to cover your traffic.
- Consider making the repo public so users can verify what they're signing.
- If you ever add a fee (Jupiter's `platformFeeBps`), get advice on whether that changes your legal position.
