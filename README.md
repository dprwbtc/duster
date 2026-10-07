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
sent. Token images always come from Duster's own origin (`/i/<mint>`, served by `/api/img`, below), never from the
host a token's creator picked, so an airdropped token's image host can't see who opened Duster.

**Dev/QA mode** (localhost only; `public/dev.js` is in `.vercelignore` and never ships):

- `http://localhost:3000/?demo`: everything from fixtures, plus a "dev · states" popover that jumps to any
  scene (landing, loading, list, empty, errors, building, review, expired quotes, wallet prompt, sending, success,
  partial failure, expired, 30+ tokens, into $LILVADER, …) and every cleanup state (list, nothing to close,
  loading, error, building, review, review with burns, burn section open, can't close any, big wallet, success,
  partial, empty wallet with rent). Add
  `&outcome=partial|expired` or `&fee=off`. A few fixtures use real mints, so `/api/img` shows real images.
- `http://localhost:3000/?watch=<address>`: a watch-only wallet that "connects" as that address, so real
  holdings, quotes, `/api/accounts`, `/api/reclaim` (build + simulate) and `/api/refresh` run against real data.
  It never signs, and `/api/send` and `/api/status` are answered from fixtures, so nothing can reach the chain.

API additions the UI uses (all backward-compatible): `/api/config` also returns `prices` (USD price of the
default outputs and the burn token, for estimates only); `/api/tokens/search` results include `usdPrice`;
`/api/plan` returns `outPrice`, `burnMint`, and per leg `minOut` (guaranteed minimum before the fee), and a
Jupiter rate limit is reported as `quote service busy` instead of `no route found`;
`/api/status?h=1` returns `{ statuses, blockHeight }` (height read first) so the UI can declare a transaction
expired once the chain passes the `lastValidBlockHeight` from `/api/refresh` (it asks twice before saying so);
`/api/send` marks an uncertain relay error with `uncertain: true` so the UI keeps tracking that signature.

Server-side limits (per warm instance, a backstop to the firewall rule below): `/api/plan` allows 40 requests
and 90 tokens per minute per IP (counted in tokens, so chunk size doesn't matter); consecutive chunks of one
preview reuse a 20s cache of the owner's balances and prices; `/api/config` is memoized for 60s;
`/api/accounts` 20/min; `/api/reclaim` 20/min and 2,000 accounts/min; `/api/img` 300/min (images have their own
firewall rule, see Deploying).

## The cleanup: rent back from token accounts (no fee)

Every SPL token account holds about 0.00204 SOL of rent (Token-2022 accounts a little more), and it stays locked
even after the account is empty. The cleanup closes empty accounts and sends that rent back to the wallet. It's
reachable from the landing ("just reclaim rent", which works for wallets with nothing to sell), from an
"empty pockets" card in the token list, from the empty-wallet state, and from the result of a swap run.

- **No fee.** Reclaim transactions carry no buy-and-burn and nothing else from Duster: the whole rent goes back to
  the wallet that paid it. The user pays only the network fee (5,000 lamports per transaction plus a priority fee
  within the same bounds as the swaps).
- **Many accounts per transaction.** Closes are packed greedily into as few transactions as fit (1232 bytes and
  64 account locks, the same check the swaps use), about 25 per transaction, up to 400 accounts and 30
  transactions per run, all approved in one wallet prompt. Signing, sending and confirming reuse the swap flow:
  fresh blockhash right before the prompt, one `signTransaction` call, `/api/send`, `/api/status` polling, and a
  review is never signed again once anything went out.
- **Burn & close (opt-in).** Accounts that still hold dust worth less than $1 (or with no price at all) can be
  burned and closed. It's collapsed and off by default, needs an explicit "burned tokens are gone for good"
  confirmation, and the server re-checks the value and refuses anything worth $1 or more. If prices can't be
  read, nothing is offered for burning. Dust with no price is listed apart as "value unknown" and never included by
  "select all": each one is ticked by hand. NFTs and other decimals-0 tokens (Jupiter has no price for them, which
  says nothing about their value) and the burn token are never offered and are refused by the server.
- **Jupiter quota.** Listing accounts costs RPC only. Prices (one paced `/price` call per 50 held mints) are read
  only when the burn section is opened, and again by `/api/reclaim` when a burn is actually requested.
- **Wrapped SOL** can be closed too: closing unwraps it, so its balance lands in the wallet with the rent.
- **Token-2022 accounts with withheld transfer fees** get `harvestWithheldTokensToMint` first (permissionless;
  those tokens were never the holder's), then close.
- Frozen accounts and accounts whose close authority is someone else are listed with the reason, never offered.

API:

- `GET /api/accounts?owner=<address>` → `{ accounts: [...], priceError }`. Every token account of the owner
  across Token and Token-2022, empty ones included: `address, mint, program, amount` (raw string)`, decimals,
  uiAmount, frozen, native, rentLamports, lamports, closeAuthority, closable, reason` (when not closable:
  `frozen`, `close authority is someone else`, `has balance`)`, burnCandidate, burnBlock, burnable, withheld, name,
  symbol, verified, usd`, plus `priced` and `priceError` at the top level. Names come from on-chain metadata
  (Metaplex PDAs read 100 per `getMultipleAccountsInfo`, or the Token-2022 metadata extension), or from Jupiter
  only when this owner's holdings are already in the same process's memory (locally; on Vercel each function has
  its own memory, so `verified` is generally false there). Without `&prices=1` the response costs RPC only:
  `usd` is null and `burnable` false everywhere, and `burnCandidate` says which accounts could be burned value
  permitting. With `&prices=1`, accounts that still hold something are priced through Jupiter (memoized for a
  minute per instance) and `burnable` is set.
- `POST /api/reclaim { owner, close: [account], burn: [account] }` → `{ txs: [{ tx, bytes, accounts: [{ address,
  mint, action: "close" | "burn+close", rentLamports, lamports, native }], rentLamports, lamports, feeLamports }],
  skipped: [{ address, reason }], blockhash, lastValidBlockHeight, cuPrice }`. Every account is re-read on the
  server and checked (owned by `owner`, owner is the close authority or none is set, not frozen; `close` accounts
  empty unless wrapped SOL; `burn` accounts below $1 or unpriced, never decimals-0 tokens or the burn token). Each transaction is simulated
  (`sigVerify: false`, `replaceRecentBlockhash: true`) and its compute limit set to 1.2× what it used. When a
  simulation fails on one instruction, that account is skipped with a plain reason and the rest re-simulated
  (bisecting when the failure can't be pinned to one account). Unsigned; capped at 400 accounts per request.

## Token images: `/api/img`

`GET /i/<mint>` (a `vercel.json` rewrite to `GET /api/img?mint=<mint>`, which also works) returns the token's image
as a 128×128 WebP from Duster's own origin. The page never loads an image from a host a token's creator picked:
airdropped tokens are often minted per wallet, so their image host would learn the visitor's IP and that this wallet
just opened Duster. The letter badge is the placeholder underneath and stays when there's no image; names that look
like lures never get a picture. The page uses the `/i/` path so a long list of pictures stays outside the `/api`
firewall budget (see Deploying). Any query parameter other than the one `mint` gets a cacheable 400, so the CDN
can't be bypassed with `&x=1`, `&x=2`, …

Images are shown for unverified tokens too (that's the point: most dust is unverified). A scam's picture can carry
a lure, so this is a deliberate trade-off: names that look like lures get no picture at all, and the rest are
re-encoded 128px thumbnails shown at 32–36px, too small for a readable URL or a scannable QR code, and never
clickable.

How it works: one `getMultipleAccountsInfo` for the mint and its Metaplex metadata PDA (requests arriving within a
few milliseconds share one call; no Jupiter calls at all), then the Token-2022 metadata extension's uri or the
Metaplex uri. The uri's JSON gives `image` (or `image_url`, or `properties.files[0]`); a uri that is itself an
image is used directly. `ipfs://` and `ar://` are mapped to public gateways. The best-known IPFS gateways
(ipfs.io, dweb.link) now refuse server clients, so content on a well-known public gateway is fetched from
`IPFS_GATEWAYS` (default `4everland.io,gateway.pinata.cloud`; w3s.link and nftstorage.link only redirect to the
refusing ones; override as gateways change, and for heavy traffic put a dedicated gateway with its own key first). Each CID starts at a different gateway (the same one every time for that CID) and falls back to the next,
so a burst of images is spread over all of them instead of queueing on one. SOL and USDC have no metadata image,
so their logos come from the Solana token-list repository. In the page, a failed image is retried once after a
minute; the letter badge shows meanwhile.

Because this makes our server fetch attacker-chosen URLs, every hop is SSRF-guarded:

- https only (http is upgraded), port 443 only, no credentials in the URL, no IP literals in any notation, no
  single-label, `localhost`, `.local`, `.internal` (and similar) hostnames;
- the address actually connected to is checked inside the TLS connect (a custom DNS `lookup`), so a hostname
  can't pass a check and then resolve somewhere private. Every resolved address must be globally routable:
  private, loopback, link-local (169.254.0.0/16, cloud metadata), CGNAT, multicast, reserved, documentation and
  unspecified ranges are refused for IPv4 and IPv6 (IPv4-mapped IPv6 is judged by the IPv4 inside; only
  2000::/3 is allowed for IPv6, minus 6to4, Teredo and documentation);
- redirects are followed by hand, at most 3, each re-checked like the first;
- time is capped per hop (4s for the metadata, 6s for the image, never past the overall deadline of about 11s,
  however many redirects) and size is enforced while streaming, on decompressed bytes (256 KB for JSON, or for
  any metadata body that isn't labelled or sniffed as an image; 8 MB for an image). Every way a response can end
  (complete, cut off mid-body, a broken compressed stream, a timeout) settles the request, and as a last resort
  the whole job is abandoned shortly after the deadline, so a misbehaving host can't hold anything open;
- each host gets 4 requests at a time, and one instance makes at most 16 outbound fetches at once (which bounds
  buffered bytes no matter how many hosts or subdomains are involved); sharp decodes at most 2 images at once.

The bytes must be PNG, JPEG, GIF, WebP or AVIF by magic number (SVG, which can carry script, is refused), are
decoded with sharp with a 40-megapixel cap, first frame only, then re-encoded as WebP (q80). Responses carry
`Content-Type: image/webp`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`.
Caching: a success is `public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800`; "no usable
image" is a 404 cached for an hour (CDN included), so a garbage mint can't make us re-fetch on every view; an image
host that rate-limited us or timed out is a 503 cached for five minutes; our own RPC failing or our rate limit is
never cached. Each instance also keeps a small LRU of recent thumbnails. `api/img.ts` runs on the Node runtime
(sharp is native) with `maxDuration: 15`.

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
   - `IPFS_GATEWAYS` (optional): comma-separated IPFS gateways `/api/img` fetches IPFS content from (each CID
     starts at a different one and falls back to the others).
   - `JUPITER_RPS` (optional): requests per second your Jupiter plan allows (Free `1` (the default with a key),
     Developer `10`, Launch `50`, Pro `150`). Calls are paced to it so previews don't stall on 429s, and at 3+ the
     page plans several chunks in parallel. Each token costs about one Jupiter call (plus one fee quote per chunk),
     so on the Free plan a 30-token preview takes about 40s; on Developer, a few seconds.
   These all stay server-side and are never sent to the browser.
3. **Add two rate limits** so nobody can drain your Jupiter/RPC quota: Project → *Firewall* → *Add rule*:
   - if Request Path starts with `/api`, rate limit to 60 requests per 60s per IP (a 30-token preview is 5
     `/api/plan` requests, and confirming polls `/api/status` every 2s);
   - if Request Path starts with `/i/`, rate limit to 600 requests per 60s per IP. Token pictures are `/i/<mint>`,
     and one long list asks for dozens of them; the firewall counts requests before the CDN cache, so keeping them
     out of the `/api` rule means scrolling a list can never get a user's preview, send or status calls blocked.

   Or with the CLI:
   ```bash
   vercel firewall rules add "API rate limit" \
     --condition '{"type":"path","op":"pre","value":"/api"}' \
     --action rate_limit --rate-limit-window 60 --rate-limit-requests 60 \
     --rate-limit-keys ip --rate-limit-action rate_limit --yes
   vercel firewall rules add "Image rate limit" \
     --condition '{"type":"path","op":"pre","value":"/i/"}' \
     --action rate_limit --rate-limit-window 60 --rate-limit-requests 600 \
     --rate-limit-keys ip --rate-limit-action rate_limit --yes
   ```
   The handlers also have a per-instance limiter, but that's only a backstop. After deploying, check that
   `curl -I https://<your-domain>/i/So11111111111111111111111111111111111111112` answers `200 image/webp`.
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
- Input validation and size caps on every endpoint (30 tokens per plan, 30 transactions per send, 400 accounts
  per reclaim). `/api/send` only relays fully signed, well-formed transactions. Errors are returned to the browser
  as generic messages.
- Token images are proxied and re-encoded by `/api/img` at `/i/<mint>` (SSRF-guarded, see above), so the CSP's
  `img-src https:` is never used for token data and visitors' IPs never reach token creators' hosts.

### What's still on you

- Your Jupiter and RPC plans need to cover your traffic.
- Consider making the repo public so users can verify what they're signing.
- The fee buys a token you may hold, which supports its price with your users' money. Disclose that
  plainly, and get advice on how it's treated where you and your users are.
- `BURN_TOKEN_MINT` for $LILVADER is `DBFcomeF97mTgRoKvHj2YtdFdvFcrLP4pFTBEPpKpump`. Several copycats share the name.
