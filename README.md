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

The UI is plain HTML/CSS/JS in `public/` (no build step). It previews in chunks of 6 tokens, one `/api/plan`
request after another, so progress is real and no single request nears the 60s function limit. The quote
freshness timer counts from the oldest chunk; once the oldest quote is older than 45s the plan is refreshed before
signing (young quotes are kept, stale ones re-quoted). `/api/refresh` stamps a fresh blockhash right before the
wallet prompt, and a plan is never signed again once any of its transactions went out (a retry is a fresh preview
of what didn't land). If the wallet never answers, the user can stop waiting; a late signature is dropped, never
sent. Token icons are only loaded for Jupiter-verified tokens, so an airdropped token's icon host can't see who
opened Duster.

**Dev/QA mode** (localhost only; `public/dev.js` is in `.vercelignore` and never ships):

- `http://localhost:3000/?demo`: everything from fixtures, plus a "dev · states" popover that jumps to any
  scene (landing, loading, list, empty, errors, building, review, expired quotes, wallet prompt, sending, success,
  partial failure, expired, 30+ tokens, into $LILVADER, …). Add `&outcome=partial|expired` or `&fee=off`.
- `http://localhost:3000/?watch=<address>`: a watch-only wallet that "connects" as that address, so real
  holdings, quotes and `/api/refresh` run against real data. It never signs, and `/api/send` and `/api/status`
  are answered from fixtures, so nothing can reach the chain.

API additions the UI uses (all backward-compatible): `/api/config` also returns `prices` (USD price of the
default outputs and the burn token, for estimates only); `/api/tokens/search` results include `usdPrice`;
`/api/plan` returns `outPrice`, `burnMint`, and per leg `minOut` (guaranteed minimum before the fee), and a
Jupiter rate limit is reported as `quote service busy` instead of `no route found`;
`/api/status?h=1` returns `{ statuses, blockHeight }` (height read first) so the UI can declare a transaction
expired once the chain passes the `lastValidBlockHeight` from `/api/refresh` (it asks twice before saying so);
`/api/send` marks an uncertain relay error with `uncertain: true` so the UI keeps tracking that signature.

Server-side limits (per warm instance, a backstop to the firewall rule below): `/api/plan` allows 40 requests
and 90 tokens per minute per IP (counted in tokens, so chunk size doesn't matter); consecutive chunks of one
preview reuse a 20s cache of the owner's balances and prices; `/api/config` is memoized for 60s.

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
   - `JUPITER_RPS` (optional): requests per second your Jupiter plan allows (Free `1` (the default with a key),
     Developer `10`, Launch `50`, Pro `150`). Calls are paced to it so previews don't stall on 429s, and at 3+ the
     page plans several chunks in parallel. Each token costs about one Jupiter call (plus one fee quote per chunk),
     so on the Free plan a 30-token preview takes about 40s; on Developer, a few seconds.
   These all stay server-side and are never sent to the browser.
3. **Add a rate limit** so nobody can drain your Jupiter/RPC quota: Project → *Firewall* → *Add rule*:
   if Request Path starts with `/api`, rate limit to 60 requests per 60s per IP (a 30-token preview is 5
   `/api/plan` requests, and confirming polls `/api/status` every 2s). Or with the CLI:
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
  total in the review, plus the burn token's full mint address. The burn token is never auto-selected for sale;
  the user has to opt in to sell it.
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
