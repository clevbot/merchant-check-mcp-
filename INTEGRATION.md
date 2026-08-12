# Pre-payment decision primitive — integration reference

Gradient Decisions provides merchant intelligence for autonomous commerce.
`x402 Merchant Check` evaluates observable on-chain payment behavior so
agents can make more informed decisions before paying unfamiliar x402
merchants. It is **not**:

- a merchant certification
- a guarantee of safety
- a replacement for the agent's own payment policy

It is a $0.01-per-check, machine-native, x402-native tool designed to be
called at exactly one moment: right before an agent pays a merchant it
hasn't dealt with before.

## Where this sits in the flow

```
DISCOVER
  (Coinbase x402 Bazaar, PayAI, or any other x402 discovery source)
  ↓
IDENTIFY PAYMENT DESTINATION
  (agent receives a 402 Payment Required response, extracts accepts[].payTo)
  ↓
GRADIENT MERCHANT CHECK
  (agent calls check_merchant — this repo)
  ↓
AGENT PAYMENT POLICY
  (agent decides what recommendation means for *its* risk tolerance)
  ↓
X402 PAYMENT
  (agent proceeds, escalates, or declines)
```

Concretely:

```
1. Agent discovers an x402 service (e.g. via Bazaar's discovery catalog)
2. Agent attempts the resource, receives 402 Payment Required
3. Agent extracts the merchant/payment address from accepts[].payTo
4. Agent calls check_merchant(merchant_wallet_address, ...)
5. Agent evaluates the recommendation field
6. Agent applies its own payment policy
7. Agent executes (or doesn't) the x402 payment
8. On success, agent retries the original request with the payment proof
```

## Mapping a 402 response to a `check_merchant` call

A typical x402 `402 Payment Required` response includes an `accepts` array:

```json
{
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "payTo": "0xffc458db291b4abce020fe3de4f91f2770e537b1",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "50000"
    }
  ]
}
```

Map directly — every field below except `merchant_wallet_address` is
optional, and none of them require the agent to look up or compute
anything it doesn't already have from the 402 response itself:

| 402 response field         | `check_merchant` input       |
| --------------------------- | ----------------------------- |
| `accepts[].payTo`           | `merchant_wallet_address` (**required**) |
| `accepts[].network`         | `network` (optional passthrough) |
| `accepts[].asset`           | `asset` (optional passthrough) |
| `accepts[].amount`          | `amount` (optional passthrough), or convert to USD and pass as `price` |
| the resource URL being paid for | `service_url` (optional passthrough) |

`network`/`asset`/`amount`/`service_url` are accepted and reserved for
future use (e.g. network-mismatch warnings) but not currently required for
scoring, which stays keyed on the wallet address alone — don't withhold a
call waiting on fields an agent might not have.

## Example agent policy

```
if merchant is unfamiliar:
    result = check_merchant(
        merchant_wallet_address = accepts[0].payTo,
        network                 = accepts[0].network,
        amount                  = accepts[0].amount,
        service_url             = resource_url,
    )

    if result.recommendation == "PROCEED":
        continue according to normal payment policy

    elif result.recommendation == "CAUTION":
        require additional scrutiny, reduced authorization,
        or human approval — inspect result.risk_flags for specifics

    elif result.recommendation == "INSUFFICIENT_SIGNAL":
        apply your own conservative default
        (e.g. cap spend, require approval) — this is a data gap,
        not a red flag; don't treat it the same as CAUTION
```

**Gradient provides decision intelligence. The agent remains responsible
for the final payment decision.**

## What the three recommendation values actually mean

| Value | Meaning | Not-guarantee framing |
| --- | --- | --- |
| `PROCEED` | Observed payment behavior provides sufficient positive evidence and no significant configured risk signals. | "Observed behavior supports proceeding" — not "this merchant is safe." |
| `CAUTION` | One or more meaningful behavioral concerns exist (see `risk_flags` for which). Agent should consider additional checks, reduced authorization, or human approval per its own policy. | Not a block — Gradient doesn't currently have evidence strong enough to justify a harder REJECT/BLOCK value (see README `_avoid_bucket` note on why a real bad-actor source doesn't exist yet). |
| `INSUFFICIENT_SIGNAL` | Not enough transaction history to make a meaningful assessment. | A data gap, not a finding — deliberately distinct from `CAUTION` so an agent doesn't treat "we don't know" the same as "we found a concern." |

`trust_tier` (`TRUSTED`/`CAUTION`/`AVOID`) and `confidence`
(`HIGH`/`MEDIUM`/`LOW`) carry richer detail for policies that want more
than the three-way `recommendation` split — see the full response shape
below.

## Full response shape

```json
{
  "merchant": "0xffc458db291b4abce020fe3de4f91f2770e537b1",
  "network": "eip155:8453",
  "recommendation": "PROCEED",
  "trust_tier": "TRUSTED",
  "confidence": "HIGH",
  "data_sufficiency": "SUFFICIENT",
  "signals": {
    "merchant_age_days": 184,
    "unique_payers": 51,
    "total_tx_count": 89635,
    "payer_concentration": "LOW"
  },
  "risk_flags": [],
  "reasons": ["Consistent signals across wallet age, payer diversity, and settlement history"],
  "price_fairness": "fair",
  "category": "data_api",
  "chain": "base",
  "platforms": [{ "url": "https://api.example.com/v1/weather", "serviceName": "Weather API" }]
}
```

`risk_flags` values map 1:1 to `src/scoring.ts`'s six signals:
`new_wallet`, `low_payer_diversity`, `payer_clustering`,
`high_abandon_rate`, `no_refund_recourse`, `price_variance`,
`velocity_anomaly`. Empty array, not null, when nothing fired.

## Observability

`GET /metrics` (admin-gated, `X-Admin-Token` header — same secret as
`/refresh`/`/categorize`) returns a summary over a configurable window
(`?window=<seconds>`, default 7 days): total checks, breakdown by
recommendation, distinct merchants checked, repeat-check rate, and
latency percentiles. See `src/db/queries.ts getMetricsSummary` for exact
semantics and known limits — the most important one: this can only measure
checks that actually reached and paid for this tool. It cannot currently
see how many x402 payment flows skipped calling it entirely, or how many
402 challenges from *this* tool's own paywall were issued but never
converted. Measuring either needs instrumentation earlier in the payment
handshake than exists today.

## Remaining gaps toward default adoption

Honest list, not a roadmap promise:

- **No standardized hook for wallets/clients to auto-invoke a third-party
  pre-payment check today.** This tool is callable by any MCP-aware agent,
  but nothing in the x402 protocol or common agent frameworks currently
  triggers a check like this automatically before a payment — that needs
  either a wallet-level convention or explicit per-framework integration
  work outside this repo.
- **No REJECT/BLOCK recommendation**, and none should be added until a
  real bad-actor evidence source exists (see `scripts/labeled-wallets.json`
  `_avoid_bucket`) — inventing one now would be a stronger-sounding guess,
  not stronger evidence.
- **Solana coverage is thinner than Base's** — see README "Solana signal
  caveats." `INSUFFICIENT_SIGNAL` is the honest, current answer for most
  Solana merchants today, not a bug to route around.
- **The funnel above `check_merchant` itself is invisible.** `/metrics`
  tells you about calls that happened; it can't yet tell you how close
  Gradient is to being the *default* pre-payment step for x402 agents at
  large, only how it's doing among the agents already calling it.
