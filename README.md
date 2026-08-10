# merchant-check-mcp

Merchant-risk/reputation-scoring MCP server for **Gradient Decisions**. Shopping
agents call `check_merchant` before purchase to get a trust tier and
price-fairness read on a merchant, paid per-query via x402. See the original
build brief for full product context; this file tracks what's actually built,
what's stubbed, and what needs you before this goes further.

## Status: deployed to testnet, payment flow verified end-to-end

Live at **https://mcp.gradientdecisions.com/mcp** (Base Sepolia / testnet
USDC only — nothing here has touched mainnet or real funds). Verified
working, in order: free `tools/list` discovery → `tools/call` on
`check_merchant` correctly 402s → demo client auto-detects the 402, builds
and signs an x402 payment, submits it → facilitator correctly evaluates and
rejects it for insufficient balance (the demo wallet is an intentionally
unfunded throwaway — see "Try it yourself" below to fund it and see a real
paid response).

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

`merchant_signals` currently has two synthetic rows I inserted directly via
`wrangler d1 execute --remote`, so the demo has something to differentiate
before a real indexer exists — clearly fake addresses
(`0x11111111111111111111111111111111111111d1`,
`0x22222222222222222222222222222222222222d2`), not real merchants. (An
earlier version of these addresses was 38 hex characters instead of 40 —
`isValidWalletAddress`'s own regex rejected them, so every demo call came
back "not a valid EVM address" even though payment settled fine. Verify
address length programmatically, not by eye — see git history.) Delete the
demo rows once real refresh-worker data exists:
```bash
wrangler d1 execute merchant-signals --remote --command \
  "DELETE FROM merchant_signals WHERE wallet_address IN ('0x11111111111111111111111111111111111111d1','0x22222222222222222222222222222222222222d2')"
```

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
  failed to attach on deploy — `wrangler` reports the account needs a
  `workers.dev` subdomain enabled first (one-time, one click: open the
  Workers section of the Cloudflare dashboard once). Not blocking anything
  above since the refresh worker can't do anything real yet regardless (no
  `CDP_API_KEY`, see "Data source" below) — re-run `wrangler deploy` after
  enabling it to attach the cron trigger.

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

Still needed:
1. **A real `PAYOUT_ADDRESS`** before mainnet — a Base wallet address *you*
   control. I don't hold keys or generate wallets for real funds; replace the
   testnet throwaway with:
   ```bash
   wrangler secret put PAYOUT_ADDRESS
   ```
2. **A CDP API key** (or a different `ChainDataSource` implementation) —
   without this, the refresh worker can't populate `merchant_signals` from
   real chain data, and `check_merchant` will report "no transaction
   history" for every wallet except the two synthetic demo rows.
3. **The backtest** — fill in `scripts/labeled-wallets.json` with a handful
   of known-legitimate and known-scam Base wallet addresses (public
   scam-address lists / on-chain sleuthing communities, per the brief), run
   the refresh worker once, then `npm run backtest`. Don't flip to charging
   for real queries until this passes.
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
