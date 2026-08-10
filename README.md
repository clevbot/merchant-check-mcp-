# merchant-check-mcp

Merchant-risk/reputation-scoring MCP server for **Gradient Decisions**. Shopping
agents call `check_merchant` before purchase to get a trust tier and
price-fairness read on a merchant, paid per-query via x402. See the original
build brief for full product context; this file tracks what's actually built,
what's stubbed, and what needs you before this goes further.

## Status: scaffolded, not deployed, not charging real money

Everything below runs against **Base Sepolia (testnet)** by default. Nothing
here has touched mainnet, DNS, or a live facilitator with real funds.

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

- [`src/index.ts`](src/index.ts) — Worker entry point. Wires
  `x402ResourceServer` (facilitator: `https://x402.org/facilitator`) +
  `ExactEvmScheme` + `createPaymentWrapper` around the `check_merchant` tool,
  served over `WebStandardStreamableHTTPServerTransport` at `/mcp`.
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
  interface. See "Data source" below — not wired to real data yet.
- [`db/schema.sql`](db/schema.sql) — D1 schema. Applied and verified
  syntactically valid via `sqlite3` (see "Local dev limitation" below for why
  not via `wrangler d1 execute`).
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
- **`CdpDataApiSource`** (`src/refresh/indexer.ts`): both methods throw
  `Error("not implemented")`. See "Data source" below.

## Data source (proposed, not committed)

You asked me to propose one. Default: **Coinbase's CDP Data API**, since
you're already on a Coinbase/CDP surface for the facilitator
(`x402.org/facilitator` is Coinbase-operated), so wallet-activity queries
likely share auth/infra with something you're already calling. This is a
placeholder behind the `ChainDataSource` interface — swap it for a subgraph,
Dune, or your own RPC-log indexer by implementing the same two methods.
**Needs a CDP API key before `runRefresh` can do anything real** — until
then, the scheduled worker will throw on every tick (intentional — it's
better than silently writing empty data). There's also a `FixtureDataSource`
for local testing without live chain access.

## Before this can run for real

1. **`PAYOUT_ADDRESS`** — a Base wallet address *you control* to receive
   USDC. I don't generate wallets or hold keys; you provide the public
   address. Set it with:
   ```bash
   wrangler secret put PAYOUT_ADDRESS
   ```
2. **A D1 database** — `wrangler d1 create merchant-signals`, then paste the
   returned `database_id` into `wrangler.toml` (currently
   `REPLACE_WITH_D1_DATABASE_ID`).
3. **A CDP API key** (or a different `ChainDataSource` implementation) —
   without this, the refresh worker can't populate `merchant_signals`, and
   `check_merchant` will report "no transaction history" for every wallet.
4. **The backtest** — fill in `scripts/labeled-wallets.json` with a handful
   of known-legitimate and known-scam Base wallet addresses (public
   scam-address lists / on-chain sleuthing communities, per the brief), run
   the refresh worker once, then `npm run backtest`. Don't flip to charging
   for real queries until this passes.
5. **Deploy** — `wrangler login` (your Cloudflare account, not something I
   can do) then `npm run deploy`.
6. **DNS** — CNAME `mcp.gradientdecisions.com` (or similar) to the deployed
   Worker. This touches your domain's DNS — your call, your Cloudflare
   account.
7. **Registry submission** — once live, submit the URL to MCP/agent tool
   registries. Explicit-permission action, and only makes sense once 1–6 are
   actually done.

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
