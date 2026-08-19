# merchant-check-mcp

**Gradient Decisions provides merchant intelligence for autonomous
commerce.** `x402 Merchant Check` evaluates observable on-chain payment
behavior so agents can make more informed decisions before paying
unfamiliar x402 merchants. Agent-native, machine-readable, x402-native —
$0.01 per check, paid via x402. It is a pre-payment decision primitive, not
a certification, a guarantee of safety, or a replacement for an agent's own
payment policy. See [INTEGRATION.md](INTEGRATION.md) for the full
discover → check → decide → pay flow, the 402-response-to-input mapping,
and the exact response shape. See the
[privacy policy](https://gradientdecisions.com/privacy) for how data is
handled. This file tracks what's actually built, what's stubbed, and what
needs you before this goes further.

## Privacy policy

Live at `gradientdecisions.com/privacy` (`src/privacy.ts`), linked from the
homepage footer and here. Drafted 2026-08-13 by Claude at direct request,
grounded in this system's actual data practices (what `query_log` and
`merchant_signals` really store — see "Internal caller-tracking dashboard"
above) rather than generic boilerplate. **Not reviewed by a lawyer** — the
page itself says so, and that caveat should stay until it has been. Contact
email is `info@gradientdecisions.com` (switched 2026-08-19 from the
developer's personal address — see "Data access policy" below for why and
how). `src/privacy.ts`'s `CONTACT_EMAIL` constant is the source of truth if
it ever needs to change again.

```
DISCOVER → IDENTIFY PAYMENT DESTINATION → GRADIENT MERCHANT CHECK → AGENT PAYMENT POLICY → X402 PAYMENT
```

## Status: two live surfaces, one product

- **Agents**: `https://mcp.gradientdecisions.com/mcp` — the paid
  `check_merchant` MCP tool. **Live on Base mainnet with real USDC**
  (switched from Base Sepolia testnet — see "Going to mainnet"; real
  settled payments confirmed in `query_log`, real tx hashes on Base). Merchant
  coverage spans both Base and Solana (PayAI/Helius) — see "Solana data
  source". Payment flow verified end-to-end: free `tools/list` discovery →
  `tools/call` correctly 402s → agent builds and signs an x402 payment,
  submits it → facilitator settles it → real tier comes back. See "Try it
  yourself" below.
- **Humans**: `https://gradientdecisions.com` — as of 2026-08-19 a minimal
  static placeholder (`src/homePlaceholder.ts`), not a live dashboard. It
  used to render every scored merchant's recommendation/signals/pricing
  directly, plus serve the same dataset as raw JSON at `/api/wallets` — see
  "Data access policy" below for why that was locked down. The real
  redesigned homepage/dashboard is a separate later task, built from Figma
  mockups, not this placeholder.

Note: the two-chain merchant-signal *data* above is separate from this
endpoint's own payment rail — `check_merchant` itself is still only paid via
Base x402 (see "Payment flow" line above); nothing about that has changed.

## Data access policy (2026-08-19)

Structured merchant data — `recommendation`, `signals`, `pricing`,
`reasons`, `platforms`, anything `check_merchant` returns — is available
**only** through the paid `check_merchant` MCP tool, paid per-query via
x402. This wasn't always true, and the change is worth recording plainly:

- `/` and `/dashboard` used to render a full live dashboard: every scored
  merchant, with its recommendation, signals, reasons, and pricing, straight
  from D1. Now a static placeholder (`src/homePlaceholder.ts`) with no D1
  query at all.
- `/api/wallets` used to serve the exact same dataset as raw JSON — no
  rendering, no throttling, trivially scriptable. Now returns `404` for
  every method and every sub-path (`/api/wallets/`, `?query` strings, HEAD,
  OPTIONS, POST, ...), with `Cache-Control: no-store` and no CORS headers.
- `/merchant/<address>` (a per-merchant profile page, added 2026-08-18 —
  see git history) is retired the same way, same reasoning: it returned the
  same fields for one wallet, and an agent calling `check_merchant` already
  has the one address it would need to read that page for free instead of
  paying. Code stays in `src/merchantProfile.ts`, unused, not deleted, in
  case a future *paid* or curated variant reuses it.

All three existed because giving humans/agents a free read of the same data
`check_merchant` charges $0.01/query for directly undercut the product.
`check_merchant` itself (`src/tool.ts`) was never affected — it has always
read directly from D1 via `src/db/queries.ts` (`getMerchantSignals`,
`getComparablePrices`, `getOwnPrices`), never through any of the routes
above, so none of this required touching the paid tool's logic or schema.

**Contact email.** The privacy policy's `CONTACT_EMAIL` (`src/privacy.ts`)
is `info@gradientdecisions.com`, replacing the developer's personal Gmail
address that used to appear there and in this file. It's set up as a
**Cloudflare Email Routing forward** to that same personal inbox — mail to
`info@` arrives at the existing Gmail, but the personal address itself no
longer appears anywhere public-facing or committed. Email Routing is
receive/forward-only: it cannot *send* mail as `info@gradientdecisions.com`.
If sending-as is ever needed, that's a separate manual task (Google
Workspace or custom SMTP), not something Email Routing does.

To enable it (Cloudflare dashboard, since this session has no Cloudflare
API token to do it via API — see "Manual steps" note in the PR/commit this
section shipped with):
1. Cloudflare dashboard → the `gradientdecisions.com` zone → **Email** →
   **Email Routing**.
2. Enable Email Routing for the zone. Cloudflare adds the required `MX`
   records (routing to its own mail servers) and a `TXT` record
   (`v=spf1 include:_spf.mx.cloudflare.net ~all`, or merged into an existing
   SPF record if one's already there) automatically — no manual DNS entry
   needed for a zone whose DNS Cloudflare already manages (true here, since
   `custom_domain = true` in `wrangler.toml` already put this zone on
   Cloudflare DNS).
3. Add a routing rule: `info@gradientdecisions.com` → **Destination
   address** → the existing personal Gmail address.
4. Cloudflare sends a verification email to that Gmail address the first
   time it's added as a destination — **this needs a human to click the
   link**, it can't be done programmatically. Until that's clicked, mail to
   `info@` won't actually forward.

## Categorization

Additive to trust-tier scoring, doesn't touch `src/scoring.ts`. Every
merchant gets a `category` from a fixed six-value set
(`src/categorize/types.ts`: `data_api`, `compute`, `content_generation`,
`financial_data`, `storage`, `other`) — never invented outside that set;
anything the pipeline can't confidently place lands in `other` and is
logged to `category_review_log` for a spot-check, not guessed.

Two passes, run once per wallet on first ingestion (not the 4-hour
trust-signal cadence — a separate monthly cron force-re-runs everyone in
case a listing's description changed, see `wrangler.toml`):
1. **Rules** (`src/categorize/rules.ts`) — keyword match against the Bazaar
   listing text. Only counts as confident if exactly one category matches;
   zero or multiple matches (ambiguous) fall through to pass 2.
2. **Model** (`src/categorize/model.ts`) — Claude Haiku (`claude-haiku-4-5-20251001`)
   given the fixed category list and the description, asked for exactly one
   value back. Response is validated against the fixed set before use —
   never trusted blindly; anything unparseable becomes `other` + logged.

**`ANTHROPIC_API_KEY`** (`wrangler secret put ANTHROPIC_API_KEY`) powers
pass 2 — without it, every non-rule-matched description lands straight in
`other` (logged as `other_model_unavailable`, not silently guessed). Set
and confirmed working on 2026-08-11. `POST /categorize` (admin-token
gated, same pattern as `/refresh`) processes the backlog — `?force=true`
re-categorizes everyone, `?limit=N` caps how many per call (default 200)
since a full force run across hundreds of wallets could exceed a single
Worker invocation's execution time (confirmed by batching 4×100 manually).

Two real bugs found by actually running this against production, not by
inspection — both fixed and redeployed:
- Rule matching used plain substring checks, which false-matched
  `"compute"` inside `"computer vision"` and would have matched a bare
  `"search"` inside `"research"`. Two real listings ("Tavily Search", "Exa
  /search endpoint") had been model-classified `content_generation` as a
  result of falling through to pass 2 when they should've ruled confidently
  to `data_api`. Fixed with word-boundary regex matching instead of
  `.includes()`.
- `runCategorization`'s `remaining` count was wrong for `force=true`: since
  that mode's WHERE clause never excludes already-processed rows, a naive
  recount just reported the total every time — caught by literally watching
  it report the same number after 4 real batches that were each actually
  processing different wallets (confirmed via `category_updated_at`
  spread). Fixed by snapshotting a timestamp before each run and counting
  rows still older than it.

Current live distribution (2026-08-11, 375 real merchants): `data_api` 145,
`other` 93 (genuinely ambiguous now, not "model unavailable"),
`financial_data` 59, `content_generation` 45, `compute` 21, `storage` 4,
8 legitimately uncategorized (stale, delisted from Bazaar since the last
refresh — untouched by design, not a bug).

## Try it yourself

```bash
npm run demo
```

**Stale as of 2026-08-11 — the deployed server only accepts Base mainnet
now** (`X402_NETWORK = eip155:8453`, see "Going to mainnet"). This script
still pays on Base Sepolia, so it'll fail against the live deployment;
kept as reference and for anyone testing a testnet-configured branch
locally. For a real, working live test, see "Mainnet live payment test"
below.

Uses the throwaway keypair in `.env.demo` (gitignored, testnet-only, zero
real value). To get past the "insufficient balance" step and see an actual
paid `trusted`/`avoid` response on a testnet deployment:

1. Get the payer address: `DEMO_PAYER_ADDRESS` in `.env.demo`
   (`0x9AaF5bB90307bacb9cB60f54c1be2B65B0771282`).
2. Fund it with Base Sepolia test USDC:
   [faucet.circle.com](https://faucet.circle.com) (select Base Sepolia).
3. Re-run `npm run demo`. The two seeded wallets
   (`0x1111...11d1` / `0x2222...22d2`, inserted directly into D1 for this
   demo — see "Demo data" below) should come back `trusted` and `avoid`
   respectively, with a real settlement tx hash.

## Mainnet live payment test

**Real money.** `scripts/mainnet-live-test.ts` makes one real $0.01 x402
payment against the live mainnet deployment — the actual proof that
settlement genuinely works end to end, not just that the facilitator
config resolves correctly (which was already verified separately without
spending anything). Deliberately not wired into `npm run demo` or any
other default command — only runs via the explicit `npm run mainnet-test`,
and only with a private key you provide via a local, gitignored
`.env.mainnet-test` file that never leaves your machine (same pattern as
every other secret in this project — I don't generate, hold, or touch it).

```bash
cd "/Users/colincleven/Documents/merchant-check-mcp"

# 1. Generate a fresh throwaway keypair (runs locally, nothing sent anywhere)
PATH="/Users/colincleven/.nvm/versions/node/v24.15.0/bin:$PATH" node --input-type=module -e "
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const k = generatePrivateKey();
const a = privateKeyToAccount(k);
console.log('address:', a.address);
console.log('private key:', k);
"

# 2. Save the private key locally (paste the value the command above printed)
cat > .env.mainnet-test << 'EOF'
MAINNET_PAYER_PRIVATE_KEY=paste_the_private_key_here
EOF

# 3. Send a small amount of real USDC on Base mainnet (e.g. $0.05) to the
#    "address:" printed in step 1, from your own wallet/exchange.

# 4. Run the real test
PATH="/Users/colincleven/.nvm/versions/node/v24.15.0/bin:$PATH" npm run mainnet-test
```

Checks a real trusted-tier merchant from the live dataset by default
(`0xffc458db291b4abce020fe3de4f91f2770e537b1`) — override with
`TEST_MERCHANT_WALLET=0x... npm run mainnet-test`. Success prints a real
transaction hash and a BaseScan link.

## Demo data

`merchant_signals` has two synthetic rows I inserted directly via
`wrangler d1 execute --remote` — clearly fake addresses
(`0x11111111111111111111111111111111111111d1`,
`0x22222222222222222222222222222222222222d2`), not real merchants, kept
around because there's still no real `avoid` example (see "Still needed"
below). They're marked `is_demo = 1` **and** tagged `network = 'eip155:84532'`
(Base Sepolia — the network the demo/test payment flow actually runs on,
vs. `eip155:8453` Base mainnet for every real `BazaarDataSource` row). Two
separate columns on purpose: `is_demo` marks *fake* rows, `network` marks
*which chain real rows came from* — different failure modes to guard
against (synthetic data vs. real testnet data leaking into the mainnet
dataset), so both stay explicit instead of collapsing into one flag. Both
filters (`WHERE is_demo = 0 AND network = 'eip155:8453'`) currently produce
an identical result set, but that changes the moment any real data source
can observe testnet activity. Excluded from the public dashboard and
`/api/wallets` (`src/dashboard.ts`) — `gradientdecisions.com` only ever
shows real mainnet data — but `check_merchant`
itself still sees them, so `npm run demo` keeps exercising all three tiers.
(An earlier version of these two addresses was 38 hex characters instead of
40 — `isValidWalletAddress`'s own regex rejected them, so every demo call
came back "not a valid EVM address" even though payment settled fine. Verify
address length programmatically, not by eye — see git history.)

## Known issue found and fixed during deployment

`resource.serviceName` in `src/index.ts`'s `createPaymentWrapper` config
must be printable ASCII only (no em-dash) and ≤32 characters —
`@x402/core`'s `ResourceInfoSchema` rejects anything else with a `ZodError`,
which silently broke payment-required detection on the client side (the
malformed response just looked like an inert error result, not something
worth auto-paying for). Found by testing against the live deployment, not
from any docs — worth knowing if you add more resource metadata elsewhere.

## Remaining one-time account setup (done)

**Stale heading, kept for history.** The `workers.dev` subdomain blocker
that failed on every single deploy this session (`wrangler` reporting the
account needed a subdomain before the cron trigger could attach) is
resolved as of 2026-08-18 — visiting the Workers section of the Cloudflare
dashboard once provisioned it. Confirmed via a live `wrangler deploy`:
```
schedule: 0 */4 * * *
schedule: 0 0 1 * *
```
Both cron triggers now attach cleanly. The refresh worker runs
automatically every 4 hours; monthly forced re-categorization runs on the
1st. Data had gone stale for 6+ days before this was caught and fixed —
worth periodically checking `lastRefreshedAt` via `/api/wallets` even with
the cron working, same as any scheduled job.

## Manual refresh trigger

Not required anymore now that the cron is attached, but still useful for
an on-demand refresh outside the 4-hour cadence (shared-secret header
`X-Admin-Token`):
```bash
curl -X POST https://mcp.gradientdecisions.com/refresh \
  -H "X-Admin-Token: <your ADMIN_TOKEN>"
```

## Internal caller-tracking dashboard

Added 2026-08-13, separate from the public merchant-scoring dashboard.
`GET /admin/callers` (same `X-Admin-Token` gate as `/refresh`/`/metrics`;
append `?format=json` for raw JSON, `?window=<seconds>` to change the
headline-stats window, default 7 days) tracks usage of `check_merchant`
itself — who's calling it, how often, what they're checking — as opposed
to which merchants score well. Not linked from the public site.

Purpose (verbatim from the request that added this): *"this caller data is
confirmed-intent ground truth (a wallet paying to check a merchant is
actively evaluating a real purchase), intended to eventually inform
buyer-side behavioral segmentation, not just merchant scoring."* That
segmentation is **not built here** — this only ships the tracking/
aggregation infrastructure (unique callers over time, query frequency per
wallet to distinguish one-off scripts from repeat/active agents, category
distribution of what's being checked, 30-day retention). Segmentation logic
is explicit future work.

**No-identity-resolution principle, same as everywhere else in this
project**: every view here is keyed on `payer_address` (the on-chain wallet
that paid) — nothing resolves that to an off-chain identity. See
`src/callerDashboard.ts` for the full design comment.

Implementation note: this mostly *extends* `query_log` (already existed for
`/metrics`) rather than a new table — added `queried_category` (the checked
merchant's category from the response) and `caller_supplied_price_atomic`
(genuinely caller-supplied, from `input.price`) as two new columns, not a
parallel logging path.

## Phase 0 resolution (stack compatibility)

Confirmed via Cloudflare's own docs and by actually installing/typechecking
against the real packages (not just reading about them):

- **MCP transport**: `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`
  — a fetch()/Request/Response-based transport whose own JSDoc includes a
  Cloudflare Workers usage example. Runs natively on Workers, no polyfills.
- **Payments**: `@x402/core` + `@x402/evm` + `@x402/mcp` — the official
  x402-foundation/Coinbase packages (same publishers as the protocol spec
  itself). **Not** `x402-hono`, and **not** Cloudflare's own `agents` package
  — see "Why not x402-hono" and "Why not Cloudflare's `agents` package" below.
- **Data store**: D1 (per brief) — relational joins across payer wallets and
  price observations need more than KV's key-value model gives you.

Net result: no fallback to Vercel/Railway was needed. Cloudflare Workers
works for both legs.

### Why not x402-hono

`x402-hono` (and the framework-middleware family generally) gates by HTTP
*route*. MCP puts every JSON-RPC method — `initialize`, `tools/list`,
`tools/call` — on a single POST endpoint. Gating the whole route would put
`tools/list` behind a paywall too, which breaks agent discovery (the brief's
own GTM plan depends on agents being able to read the tool description before
deciding to pay). `@x402/mcp`'s `createPaymentWrapper` instead wraps a
*specific tool handler*, so discovery stays free and only `check_merchant`'s
actual execution is metered.

### Why not Cloudflare's `agents` package

The initial plan (before checking) was Cloudflare's `agents` package
(`createMcpHandler`, built on `@modelcontextprotocol/server`). Once actually
installed, `@x402/mcp` turned out to depend directly on
`@modelcontextprotocol/sdk` (a different, if related, package) — and there's
no documented integration between `@x402/mcp` and `agents`' MCP server
wrapper. Rather than combine two payment-adjacent SDKs in a way nobody's
documented, this uses `@modelcontextprotocol/sdk` directly, exactly as
`@x402/mcp`'s own README examples do. `agents` isn't a dependency here at
all.

## Platform / website info

Added 2026-08-12. `check_merchant` and the dashboard now surface the actual
resource URL(s) (and service name, where the discovery feed gives one) a
merchant wallet backs — e.g. `https://api.example.com/v1/weather` — not just
the raw wallet address. This isn't new data collection: both Bazaar and
PayAI already return a `resource` URL + `serviceName` per listing, it was
previously only ever blended into `bazaar_description`'s free-text blob
(for categorization) and thrown away otherwise. `MerchantSignalRow.
platforms_json` (JSON array of `{url, serviceName}`, one wallet can back
several resources) stores it structured now; `CheckMerchantOutput.platforms`
surfaces it to callers; the dashboard's Platform column links to it
directly. NULL/empty until a wallet's been ingested at least once — same
status as `category`, not a scoring input.

## What's built

- [`src/index.ts`](src/index.ts) — Worker entry point, routed by pathname
  (not hostname, so it works on the workers.dev fallback URL too): `/mcp`
  wires `x402ResourceServer` + `ExactEvmScheme` + `createPaymentWrapper`
  around `check_merchant` over `WebStandardStreamableHTTPServerTransport`;
  `/` and `/dashboard` serve the human dashboard; `/api/wallets` the same
  data as JSON; `/refresh` the admin-gated manual refresh trigger.
- [`src/dashboard.ts`](src/dashboard.ts) — public dashboard (served at
  `gradientdecisions.com`, same Worker as the MCP endpoint at
  `mcp.gradientdecisions.com`). Self-contained HTML/CSS/JS, no external
  dependencies, light/dark aware, client-side search + tier filter. Excludes
  `is_demo = 1` rows — see "Demo data".
- [`src/tool.ts`](src/tool.ts) — `check_merchant` logic. Reads only from D1
  (`merchant_signals`, `price_observations`) — no chain access on the paid
  request path, per the brief's precomputed-store requirement.
- [`src/scoring.ts`](src/scoring.ts) — rules-based v1 composite. Every
  `reasons` entry maps to one named signal; thresholds are constants at the
  top of the file.
- [`src/refresh/index.ts`](src/refresh/index.ts) — scheduled worker (cron:
  every 4 hours, see `wrangler.toml`) that aggregates raw activity into
  `merchant_signals` rows.
- [`src/refresh/indexer.ts`](src/refresh/indexer.ts) — `ChainDataSource`
  interface + `BazaarDataSource`, a real (not stubbed) implementation
  against the public x402 Bazaar. See "Data source" below.
- [`src/refresh/solana-indexer.ts`](src/refresh/solana-indexer.ts) —
  `PayAIDataSource`, the Solana counterpart to `BazaarDataSource`: PayAI
  discovery + optional Helius payer-diversity augmentation. See "Solana
  data source" below.
- [`src/chains.ts`](src/chains.ts) — chain detection/address normalization
  shared by every module that touches a wallet address, now that the store
  holds both Base (0x-hex, case-insensitive) and Solana (base58,
  case-sensitive) wallets in one table.
- [`db/schema.sql`](db/schema.sql) — D1 schema. Applied to the live remote
  `merchant-signals` D1 database (`wrangler d1 execute --remote`).
- [`scripts/backtest.ts`](scripts/backtest.ts) +
  [`scripts/labeled-wallets.json`](scripts/labeled-wallets.json) — the
  brief's required validation step, before charging for real queries.

## What's deliberately stubbed

- **Signal 6 (velocity/harness-break anomalies)**: per your 2026-08-10
  decision, the buyer-side wallet-harness pipeline doesn't exist yet, so
  `detectVelocityAnomalyStub()` in `src/refresh/index.ts` always returns "no
  anomaly" rather than a fabricated heuristic that would silently miscalibrate
  the tier logic. Replace its body once that pipeline exists.
- **Payer-clustering (signal 2's cluster flag)**: same file, hardcoded to 0.
  A real implementation needs to check whether payer wallets share funding
  sources or were created in a burst — out of scope until there's a real data
  source to check it against.
- **Wallet age (signal 1)** and **refunds (signal 4)**: `BazaarDataSource`
  can't see these (see "Data source" below) — every Bazaar-sourced row has
  `wallet_age_days = null` and `refund_count = 0`, so `scoreMerchant()` never
  flags either for real data yet. Not fabricated as "fine", just unmeasured.
- **Price variance (signal 5)**: same reason — `BazaarDataSource` never
  populates `price_observations`, so `computePriceVarianceFlag()` always
  returns 0 for real data. The logic itself is real and already wired up;
  it activates for free once a source that can populate this exists.

## Data source

**`BazaarDataSource`** (`src/refresh/indexer.ts`) — real, not stubbed. Pulls
from the **x402 Bazaar**, Coinbase's own facilitator discovery catalog
(`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`) —
public, no account or API key needed. Confirmed live: as of 2026-08-10 it
has ~14,500 registered resources; a refresh run indexed 365 unique Base-
mainnet merchant wallets from the first 2,000, giving real
`total_tx_count` / `unique_payer_count` from Coinbase's own 30-day
call-volume and unique-payer metrics per merchant.

Real scope limits (see "What's deliberately stubbed" above for exactly which
signals this affects): only covers merchants who've registered a resource on
Bazaar, not every wallet that's ever received an x402 payment; no
first-activity timestamp; no settlement-completion or refund visibility from
a directory listing; Bazaar's "resource" (an API endpoint) doesn't map to
the goods/services `resource_type` buckets `check_merchant`'s price-fairness
check uses.

Filling those gaps means either Coinbase's CDP wallet-history API (needs a
free CDP account + API key at
[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/access/api) —
account creation has to be you, not me) or a custom chain indexer. Both are
future work, not blocking anything currently running. `FixtureDataSource`
is also available for local testing without live network access.

## Solana data source

Added 2026-08-12 (requirement: Solana carries real, live x402 volume today,
not just testnet activity, so it feeds the same trust-tier scoring Base
does — see `src/refresh/solana-indexer.ts` for the full implementation
writeup). Two pieces:

**Discovery — `PayAIDataSource`.** The brief's original plan was "Solana's
x402 Agent Registry," but that name doesn't correspond to a real merchant
catalog: `solana.com/agent-registry` turned out to be a *buyer*-side agent-
identity product, not merchant discovery. The real functional equivalent is
**PayAI Network's facilitator discovery feed**
(`https://facilitator.payai.network/discovery/resources`) — confirmed live
via direct curl during research: 25,928 total items, a mixed Base+Solana
catalog in the same discovery-list JSON shape as x402 Bazaar. Free, public,
no key. Unlike Bazaar, it has no `quality` field on any sampled item — no
call-volume or unique-payer counts ship with the listing itself.

**Payer-diversity augmentation — Helius (optional, `HELIUS_API_KEY`).** Fills
the gap PayAI's discovery feed leaves. For each Solana merchant wallet PayAI
surfaces, counts real USDC (SPL) transfers to that wallet via Helius's
Enhanced Transactions API (`mainnet.helius-rpc.com` — not `api.helius.xyz`,
which 401s; Helius moved this endpoint onto their RPC host, found the hard
way via a live failed refresh, confirmed against their current docs) and the
unique source addresses behind them — capped at 8 wallets, 1 page (100 txs)
per wallet per refresh run. That cap is **not** Helius's free-tier limit
(1M credits/month comfortably covers far more); it's this Cloudflare
account's real, confirmed-live Worker subrequest budget: ~50 external
fetches per invocation, shared across `BazaarDataSource` (≤20 pages),
`PayAIDataSource`'s own discovery pages (≤5), Helius augmentation, and any
first-time-wallet categorization calls to Anthropic (capped separately at 8
per run in `src/refresh/index.ts`) — all in the *same* invocation, since
`runRefresh` runs every source back-to-back. First deploy of this feature
hit exactly this ceiling (`Too many subrequests by single Worker
invocation`, caught via `wrangler tail` against a real production request,
not simulated) before these caps existed. Raising Cloudflare's Workers plan
(Bundled/Paid raises the ceiling to 1000) would remove the need for this
tight a budget — a real option, left as a billing decision for you rather
than done here. Wallets beyond the cap, or with `HELIUS_API_KEY` unset
entirely, keep PayAI's bare listing (usually 0 calls / 0 payers) —
`scoreMerchant()` reads that as insufficient data, not a trust signal either
way, never a guess.

**Why Helius and not x402scan's paid API.** x402scan (`x402scan.com`) is a
chain-agnostic x402 explorer with its own real per-call paid API
($0.01–0.02/call via x402, confirmed from its own OpenAPI spec) that would
give richer, x402-specific merchant/transaction data than raw Helius
transfer-counting can. Decided against it for this v1 for a concrete reason,
not a blanket "avoid paid data" stance — using it would mean this backend
autonomously holding and spending from a funded wallet on a schedule, a
custody/architecture commitment bigger than "is $5–15/month reasonable."
Helius's free tier gets real, live Solana payer-diversity data shipped now
without that commitment. This isn't a closed door: once Helius-based data is
live, the plan is to compare what it actually delivers against what
x402scan's paid API would add on top, with real numbers instead of
speculation, and revisit from there — see conversation history 2026-08-12
for the fuller reasoning (the business-model symmetry point: an aggregator
that itself charges for data isn't inherently wrong to pay a nominal fee
for better upstream data — the open question is what marginal value it buys
over what's already free, not whether spending is acceptable in principle).

## Price fairness caveats

Referenced from `src/scoring.ts`'s `scorePriceFairness` comment. Two real
findings from 2026-08-13, both checked against live production data before
acting on them, not assumed:

- **The original ±25%-of-median "fair" band was wrong, confirmed against
  real data.** Checked the live price distribution across all six
  categories (392 priced merchants): only 19% landed on "fair," with
  "high"/"low" each roughly 2x more common — not because most merchants are
  actually mispriced, but because real category price spreads are far wider
  than ±25%. `data_api` alone spans $0.001 to $5.12 (a >5000x range); every
  category's real interquartile range (p25–p75) covers roughly 2–5x the
  median in *each* direction. Recalibrated `HIGH_PRICE_RATIO`/
  `LOW_PRICE_RATIO` to 3.0x/0.35x, chosen from that observed IQR rather than
  guessed — produces 52% fair with high/low roughly balanced (99/91) against
  the same live data. Same epistemic status as the payer-diversity fixes
  above: real-data-grounded, not proven-optimal.
- **This does not fully fix the underlying cause — category is a coarse
  bucket.** The six categories (`data_api`, `compute`,
  `content_generation`, `financial_data`, `storage`, `other`) each bundle
  genuinely different kinds of resource at genuinely different natural
  price points (e.g. a simple lookup API and a complex real-time analysis
  API can both be `data_api`). Widening the ratio band reduces false
  high/low flags but doesn't make "compared to every other `data_api`
  merchant regardless of what it actually does" a precise comparison —
  `price_fairness`/`pricing.fairness_vs_category` should be read as a rough
  signal, not a precise valuation, until (if ever) a finer-grained resource
  taxonomy exists to compare within.

## Solana signal caveats

Referenced from `db/schema.sql`'s `velocity_anomaly_flag` comment and
`src/scoring.ts`'s per-signal cross-chain read — collected here in one place:

- **Helius counts any USDC transfer, not specifically x402 payments.** A
  merchant receiving USDC through some other channel (a direct transfer, an
  unrelated payment app) looks like extra x402 volume. Bazaar has the
  mirror-image gap on Base (undercounting — it only sees registered
  listings). Neither source is ground truth; both are documented
  approximations.
- **`firstSeenAt` is window-bounded, not true wallet age**, for Solana rows —
  it only reflects the earliest transfer within the 90-day lookback and the
  3-page-per-wallet Helius cap, same null-vs-approximate tradeoff Bazaar-
  sourced Base rows already have for this signal (Bazaar gives no
  first-activity timestamp at all).
- **Fee-payer sponsorship is NOT a misattribution risk.** Solana's x402
  "exact" scheme cryptographically excludes the fee-payer from being
  transfer source/authority/destination (see
  `specs/schemes/exact/scheme_exact.md` in `x402-foundation/x402`) — a
  counted transfer's source address is always the real payer, never a
  sponsoring relayer. Verified against the spec directly, not assumed.
- **Signal 6 (velocity/harness-break) is the one signal known NOT to
  translate once implemented**, not just currently stubbed like it is on
  Base. Solana settles roughly 4x faster (~0.5s vs Base's ~2s) — a
  transaction-frequency threshold tuned on Base traffic would over-flag
  entirely normal Solana activity as anomalous. Whoever builds this signal
  needs Solana-specific thresholds, not Base's reused unmodified.
- **Signal 2's diversity-ratio threshold (`LOW_PAYER_DIVERSITY_RATIO = 0.3`
  in `src/scoring.ts`) is Base-calibrated, not cross-chain-validated.** The
  ratio itself (`unique_payers / total_tx`) is dimensionless and should
  translate in principle, but the specific cutoff was derived from 365 real
  Base Bazaar merchants only. Treat it as an assumption until enough
  Helius-augmented Solana rows exist to check it against real Solana payer
  distributions.
- **USDC decimals match across chains (both 6)** — cross-checked against
  x402scan's own facilitator constants and Solana's official USDC mint
  registry — so atomic-unit price comparisons in
  `db/queries.ts getComparablePrices` are valid across Base and Solana
  within the same category without any conversion step. This is the one
  place cross-chain comparison is *intentionally* pooled rather than kept
  separate — see that function's own comment for why.

## Done vs. still needed

**Corrected 2026-08-12 — most of this list was stale**, written back when
the deployment was still testnet-only; several "still needed" items below
had actually already been completed and the list hadn't been updated to
say so. Verified against the live deployment before rewriting, not just
edited from memory.

Done:
- ✅ Cloudflare account authenticated (`wrangler login`, developer's own account).
- ✅ D1 database created (`merchant-signals`) and schema applied remotely.
- ✅ **Live on Base mainnet**, real `PAYOUT_ADDRESS` — confirmed via real
  settled mainnet transactions with real tx hashes in `query_log` (I never
  saw or handled the actual address value, consistent with this project's
  security practice throughout).
- ✅ Deployed to `mcp.gradientdecisions.com` (`custom_domain = true` in
  `wrangler.toml` auto-provisioned DNS + SSL since the zone was already on
  this Cloudflare account).
- ✅ Two synthetic demo rows seeded into `merchant_signals` (see "Demo data").
- ✅ Real data source wired and run: `BazaarDataSource` indexes real Base
  mainnet merchant wallets from the public x402 Bazaar (no account needed).
- ✅ Backtest passes against real data: 2/2 cases (`trusted` + `caution`,
  both real Bazaar merchants — see `scripts/labeled-wallets.json`). `avoid`
  is still explicitly unvalidated — no real bad-actor source exists yet
  (see `_avoid_bucket` in that file for why a thin-history wallet isn't a
  valid stand-in) — genuinely still open, not corrected here.
- ✅ Solana added as a second data source (2026-08-12): `chain` column
  migrated onto remote D1, `PayAIDataSource` + Helius wired into
  `runRefresh()` alongside `BazaarDataSource`, `check_merchant` output and
  the dashboard both surface `chain`, tool descriptions rewritten for
  semantic-intent matching mentioning both chains, `platforms` (merchant
  website/API URLs) surfaced in output and dashboard — see "Solana data
  source" and "Platform / website info" above.
- ✅ `HELIUS_API_KEY` set and confirmed working — real Solana payer-diversity
  data flowing (see "Solana data source").
- ✅ `ANTHROPIC_API_KEY` set 2026-08-11, confirmed working, categorization
  backlog processed.
- ✅ Registry submission — live on the official MCP registry
  (`com.gradientdecisions/merchant-check`) and indexed by third-party
  directories (e.g. mcp.so) as a result. **Worth a periodic check**: these
  directories may cache descriptions and not immediately reflect README/tool
  changes made here — if something there looks stale, it's a caching lag on
  their end, not necessarily a stale source here, but check both.
- ✅ `workers.dev` subdomain enabled 2026-08-18 — the cron trigger now
  attaches on deploy (confirmed live, see "Remaining one-time account
  setup" above). Data had silently gone stale for 6+ days before this was
  caught; the automatic 4-hour refresh should prevent that recurring, but
  it's still worth spot-checking `lastRefreshedAt`.

Still genuinely needed:
1. **A real `avoid` example** for the backtest — needs either a genuine
   x402-specific bad-actor source (none found publicly — the tech's too new)
   or enough real usage data over time to observe one organically.
3. **Robinhood Chain calibration data source** — explicitly deferred
   2026-08-13, not forgotten. Chain ID 4663 (Arbitrum Orbit L2, live since
   2026-07-01) and its Virtuals Protocol / Agentic Accounts ecosystem are
   real and confirmed, but two things are still missing before building
   this: (a) real, verified contract addresses for identifying agent
   wallets — public search only turned up what look like unofficial
   imitation tokens riding the "Agentic" branding, not genuine Robinhood/
   Virtuals infrastructure; (b) the stated purpose (calibrate harness-break
   detection against "the same logic currently running on Base") has no
   real baseline yet — signal 6 is a permanent stub (`detectVelocityAnomalyStub`,
   always 0) on Base today. Either a real contact with verified addresses,
   or building signal 6 for real first, unblocks this.

## Going to mainnet (done)

**Stale heading, kept for history — this already happened.** `X402_NETWORK`
in `wrangler.toml` is `"eip155:8453"` (Base mainnet), not the Sepolia
testnet value this section originally described. `PAYOUT_ADDRESS` receives
real USDC from real callers; `query_log` has real settled Base mainnet
transactions with real tx hashes, confirmed directly against remote D1 (see
"Try it yourself" above). If this ever needs to move back to testnet for
local dev, the value to change is the same one-line `X402_NETWORK` edit
this section originally documented, just in reverse.

## Local dev limitation (this machine)

`wrangler dev` / `wrangler d1 execute --local` need workerd, which requires
macOS 13.5.0+; this machine is on 12.6.0, so neither ran here. Schema syntax
was instead verified directly with `sqlite3` (D1 is SQLite-compatible) — all
three tables created cleanly. `npm run typecheck` passes end-to-end. Actual
runtime testing (`wrangler dev`, then hitting `/mcp` with a real MCP client)
needs either a newer macOS, a Linux devcontainer, or testing directly against
`wrangler dev --remote` / a deployed Worker.

## Known rough edge

`query_log` (usage/revenue visibility, not a scoring input) logs `"settled"`
as a placeholder `tier_returned` instead of the real tier — `@x402/mcp`'s
`onAfterSettlement` hook doesn't have access to the tool handler's return
value, only payment/settlement info. Fine for v1; see the comment in
`src/index.ts` if this ever needs to carry the real tier.

## category and price_fairness now actually reach agents

Until 2026-08-11, `category` existed only in D1/the dashboard —
`check_merchant`'s response never included it — and `price_fairness` was a
permanent `"unknown"` stub for every real merchant, since nothing had ever
populated `price_observations`. Both fixed: `category` is in the tool's
output now, and `price_fairness` compares a merchant's price against real
peers in its own category (not the old caller-supplied `resource_type`,
which nothing ever populated data for — kept in the input schema for
compatibility, documented as unused).

Three real bugs surfaced getting this actually working end-to-end against
production (each found via `wrangler tail` against a real failing request,
not by inspection):
1. Per-wallet D1 writes for price data (up to one INSERT per resource, some
   wallets have 65+) blew through D1's 1000-queries-per-invocation cap
   across ~370 wallets in one refresh. Fixed by restructuring to bulk
   operations — one upfront category lookup instead of 370, price rows
   accumulated in memory and written as ~20 chunked statements at the end.
2. D1's real bound-parameter limit is ~100/statement, not SQLite's usual
   999, and not stated in D1's own error message. `env.DB.batch()` sums
   params across every statement in the call against that same ceiling —
   batching multiple large inserts together doesn't dodge it, only fewer
   total bound params per individual statement does.
3. `getComparablePrices` sorted by `observed_at DESC` for recency, but
   every row from one bulk refresh shares the exact same timestamp —
   sorting a fully-tied key returns an arbitrary, non-representative
   subset. A real merchant priced 50-500x below its category's true
   median still came back `"high"`, because the `LIMIT 200` subset it
   landed on was itself skewed low. Fixed with `ORDER BY RANDOM()`.

Verified live: a real `data_api` merchant's category appears correctly in
`check_merchant`'s output, and price_fairness resolves `fair`/`low`/`high`
correctly around the real computed median (~$0.01, from 735 real
comparable observations) for that category.
