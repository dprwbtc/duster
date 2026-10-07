# Duster

Swap many dust tokens into one asset (SOL by default) using Jupiter Swap V2 `/build`:
one transaction per token, all approved in a single wallet prompt.

```bash
cp .env.example .env   # fill in JUPITER_API_KEY, RPC_URL, KEYPAIR_PATH
set -a; . ./.env; set +a
npm start                      # dry run: list dust, build + simulate
npm start -- --execute         # send (asks to confirm)
npm start -- --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --max-usd 5 --exclude <mint>
```

Flags: `--to`, `--max-usd`, `--min-usd`, `--slippage` (bps), `--max-loss-pct`, `--max-accounts`,
`--exclude`, `--only`, `--no-close`, `--execute`, `--yes`.

Dry-run any wallet exactly like the website does (public address only, nothing is signed):

```bash
npm start -- --owner <wallet address> --fee-mint DBFcomeF97mTgRoKvHj2YtdFdvFcrLP4pFTBEPpKpump --max-usd 5
```

Notes
- One transaction per token, like the old BONKscooper. A Solana tx is limited to 1232 bytes and 64 accounts, so
  each swap first tries Jupiter's widest routes (`--max-accounts`, default 64, usually the best price) and only
  falls back to tighter routes when the transaction wouldn't fit.
- Tokens with no reliable Jupiter price are never touched. Routes losing >`--max-loss-pct` vs. oracle price are skipped.
- Emptied source token accounts are closed to reclaim rent unless `--no-close`.
- Each tx is simulated; a token that fails is skipped without blocking the rest. If an emptied account can't be
  closed (e.g. Token-2022 with withheld transfer fees), the swap goes ahead and the account is kept.

## Web UI (local)

```bash
npm run web      # then open http://localhost:3000
```

Needs only `JUPITER_API_KEY` (and ideally `RPC_URL`). No private key: users connect Phantom, Solflare or
Backpack and sign in their wallet. The local server runs the same handlers and security headers as Vercel.

## Deploying to Vercel

Layout: `public/` is the static site, `api/*.ts` are Vercel Functions, `src/` is shared code.

1. **Import the repo** in Vercel → *New Project*. Leave **Root Directory** as the default and set the
   framework preset to **Other**. `vercel.json` handles the rest.
2. **Environment variables** (Production and Preview):
   - `JUPITER_API_KEY`: from https://developers.jup.ag/portal. Every visitor's requests use your quota,
     so check which plan's rate limits you need.
   - `RPC_URL`: **required in production.** Use a paid RPC (Helius, Triton, QuickNode, …). The public
     endpoint rate-limits hard and blocks the token-account lookups this app needs.
   - `BURN_TOKEN_MINT` (optional): turns on the buy-and-burn fee (see below). Leave it unset for no fee.
   - `FEE_BPS` (optional, default `100` = 1%, max `500`).
   These all stay server-side and are never sent to the browser.
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

### Buy-and-burn fee

When `BURN_TOKEN_MINT` is set, each token's transaction ends with two extra steps. The first swaps `FEE_BPS` of
that swap's **minimum guaranteed output** into the burn token. The second burns what the swap guarantees,
reducing the token's supply. Any extra from positive slippage stays with the user.

- **Atomic:** the swap, its fee swap and the burn are in the same transaction, so they all happen or none do.
  Users are never charged for a failed swap, and a swap never goes through without its burn.
- **Non-custodial:** you never receive or hold the fee, and no server wallet or cron job is involved. Every
  burn is a public on-chain instruction anyone can verify.
- **No fee into the burn token:** when the user swaps into the burn token itself, no fee is added.
- **No fee, no swap:** if the fee swap can't be routed (for example, burn-token liquidity is too thin at that
  moment), those swaps are skipped with a "try again" message. They never go through without the fee.
- **Disclosed up front:** the UI shows the fee before preview, in the bottom bar, per transaction, and as a
  total in the review, plus the burn token's full mint address.
- **Costs space:** the fee swap shares the transaction with the dust swap, so some dust swaps use a tighter
  route (slightly worse price) to make room. Into SOL there's plenty of room; into USDC it's tighter.
- **CLI exempt:** the CLI (`npm start`) is your personal tool and never charges the fee.

### What protects users

- Non-custodial: the server only builds **unsigned** transactions. The user's wallet signs, and shows the
  balance changes before approval.
- The server re-reads balances and prices itself and ignores amounts sent by the browser. It skips tokens with no
  reliable price and routes that lose more than the user's limit (capped at 50%). Slippage is capped at 20%.
- Every transaction is simulated before it's offered for signing. A plan older than 45s is rebuilt before
  signing, and transactions get a fresh blockhash right before the wallet prompt so they don't expire.
- Strict Content-Security-Policy (scripts only from this site), `frame-ancestors 'none'` against
  clickjacking. Token names are rendered as text, never HTML.
- Input validation and size caps on every endpoint (30 tokens per plan, 30 transactions per send). `/api/send`
  only relays fully signed, well-formed transactions. Errors are returned to the browser as generic messages.

### What's still on you

- Your Jupiter and RPC plans need to cover your traffic.
- Consider making the repo public so users can verify what they're signing.
- The fee buys a token you may hold, which supports its price with your users' money. Disclose that
  plainly, and get advice on how it's treated where you and your users are.
- `BURN_TOKEN_MINT` for $LILVADER is `DBFcomeF97mTgRoKvHj2YtdFdvFcrLP4pFTBEPpKpump`. Several copycats share the name.
