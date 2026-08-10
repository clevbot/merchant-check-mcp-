# merchant-check-mcp

Merchant-risk/reputation-scoring MCP server for **Gradient Decisions**. Shopping
agents call `check_merchant` before purchase to get a trust tier and
price-fairness read on a merchant, paid per-query via x402. See the original
build brief for full product context; this file tracks what's actually built,
what's stubbed, and what needs you before this goes further.

## Status: two live surfaces, one product

- **Agents**: `https://mcp.gradientdecisions.com/mcp` — the paid
  `check_merchant` MCP tool. Payment flow verified end-to-end (still on Base
  Sepolia / testnet USDC — nothing here has touched mainnet or real funds):
  free `tools/list` discovery → `tools/call` correctly 402s → demo client
  builds and signs an x402 payment, submits it → facilitator settles it →
  real tier comes back. See "Try it yourself" below.
- **Humans**: `https://gradientdecisions.com` — a public dashboard of every
  scored merchant (363 real wallets as of the last refresh, sourced from the
  x402 Bazaar — see "Data source"), searchable and filterable by tier. Same
  underlying data agents pay for via MCP, free to browse. Raw JSON at
  `/api/wallets`.

## Try it yourself

```bash
npm run demo
```

Uses the throwaway keypair in `.env.demo` (gitignored, testnet-only, zero
real value). To get past the "insufficient balance" step and see an actual
paid `trusted`/`avoid` response:

1. Get the payer address: `DEMO_PAYER_ADDRESS` in `.env.demo`
   (`0x9AaF5bB90307bacb9cB60f54c1be2B65B0771282`).
2. Fund it with Base Sepolia test USDC:
   [faucet.circle.com](https://faucet.circle.com) (select Base Sepolia).
3. Re-run `npm run demo`. The two seeded wallets
   (`0x1111...11d1` / `0x2222...22d2`, inserted directly into D1 for this
   demo — see "Demo data" below) should come back `trusted` and `avoid`
   respectively, with a real settlement tx hash.

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

## Remaining one-time account setup

- **`workers.dev` subdomain**: the scheduled refresh-worker cron trigger
  still fails to attach on deploy — `wrangler` reports the account needs a
  `workers.dev` subdomain enabled first (one-time, one click: open the
  Workers section of the Cloudflare dashboard once). Not currently blocking
  anything else — see "Manual refresh trigger" below for the workaround —
  but re-run `wrangler deploy` after enabling it to attach the cron and stop
  needing that workaround.

## Manual refresh trigger

Until the cron above is attached, `POST /refresh` (shared-secret header
`X-Admin-Token`, value in `.env.demo` as `ADMIN_TOKEN`) runs the refresh
worker on demand:
```bash
curl -X POST https://mcp.gradientdecisions.com/refresh \
  -H "X-Admin-Token: $(grep ADMIN_TOKEN .env.demo | cut -d= -f2)"
```
Useful permanently too, even after the cron works, for an on-demand refresh
outside the 4-hour cadence.

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

## Done vs. still needed

Done (testnet, this session):
- ✅ Cloudflare account authenticated (`wrangler login`, colin.cleven@gmail.com).
- ✅ D1 database created (`merchant-signals`) and schema applied remotely.
- ✅ `PAYOUT_ADDRESS` secret set — **currently a throwaway testnet keypair I
  generated** (`0x497e...118b`, see `.env.demo`), not a real wallet you
  control. Fine for testnet demoing; **must be replaced before mainnet** —
  see below.
- ✅ Deployed to `mcp.gradientdecisions.com` (`custom_domain = true` in
  `wrangler.toml` auto-provisioned DNS + SSL since the zone was already on
  this Cloudflare account).
- ✅ Two synthetic demo rows seeded into `merchant_signals` (see "Demo data").
- ✅ Real data source wired and run: `BazaarDataSource` indexed 365 real Base
  mainnet merchant wallets from the public x402 Bazaar (no account needed) —
  97 scored `trusted`, 267 `caution`, plus the 1 synthetic `avoid` row.
- ✅ Backtest passes against real data: 2/2 cases (`trusted` + `caution`,
  both real Bazaar merchants — see `scripts/labeled-wallets.json`). `avoid`
  is explicitly unvalidated — no real bad-actor source exists yet (see
  `_avoid_bucket` in that file for why a thin-history wallet isn't a valid
  stand-in).
- ✅ Manual refresh trigger (`POST /refresh`) as a workaround until the cron
  attaches — see "Manual refresh trigger" below.

Still needed:
1. **A real `PAYOUT_ADDRESS`** before mainnet — a Base wallet address *you*
   control. I don't hold keys or generate wallets for real funds; replace the
   testnet throwaway with:
   ```bash
   wrangler secret put PAYOUT_ADDRESS
   ```
2. **`workers.dev` subdomain** — one dashboard click, see above, to attach
   the cron and retire the manual-trigger workaround.
3. **A real `avoid` example** for the backtest — needs either a genuine
   x402-specific bad-actor source (none found publicly — the tech's too new)
   or enough real usage data over time to observe one organically.
4. **Registry submission** — once you're ready for real agents to find it,
   submit the URL to MCP/agent tool registries. Explicit-permission action —
   ask before I'd do this even once mainnet is live.

## Going to mainnet

Everything currently points at Base Sepolia
(`X402_NETWORK = "eip155:84532"` in `wrangler.toml`). Switching to
`"eip155:8453"` (Base mainnet) means `PAYOUT_ADDRESS` starts receiving real
USDC from real callers — don't do this until the backtest passes and you've
decided you're ready to actually charge people. This is a one-line change,
deliberately not automated.

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
