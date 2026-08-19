/**
 * "Agent readiness" quick wins (2026-08-19), added at the user's request
 * after reviewing Cloudflare's Agent Readiness diagnostics for this zone.
 * All implemented in-Worker rather than via Cloudflare's dashboard toggles
 * (AI Crawl Control / "Markdown for Agents"), on purpose:
 * - "Markdown for Agents" requires a Pro plan — this gets the same
 *   outcome (content negotiation on Accept: text/markdown) for free,
 *   in code, no plan upgrade needed.
 * - robots.txt / Content Signals / AI-crawler allow-rules are all
 *   expressible as plain robots.txt content, which the diagnostic itself
 *   reads directly — no separate dashboard config required, and it stays
 *   in version control like everything else in this project.
 *
 * This site's whole purpose is being read by AI agents (it's a paid tool
 * *for* agents), so the posture below is permissive by design: allow
 * crawling and citation broadly, just keep bots out of admin/retired
 * routes that 404 anyway. The one real judgment call is `ai-train` in the
 * Content-Signal line below — see that constant's own comment.
 */
import type { DashboardSummary, RecommendationCounts } from "./dashboard";
import type { CheckMerchantOutput } from "./types";

const SITE_ORIGIN = "https://gradientdecisions.com";
const MCP_ORIGIN = "https://mcp.gradientdecisions.com";

/**
 * Canonical example check_merchant call/response (2026-08-19) — single
 * source of truth, imported both here (auth.md) and by src/index.ts's
 * declareDiscoveryExtension `example`/`output.example` fields, which used
 * to carry their own separately-typed-out copy of the same object. Not
 * real data: the merchant address, counts, and platform URL are all
 * illustrative — matches this project's standing rule (see README "Data
 * access policy") that nothing real is given away for free, but a sample
 * of the *shape* of what $0.01 buys is fair game and actively useful for
 * agent integration.
 */
export const SAMPLE_CHECK_MERCHANT_INPUT = {
  merchant_wallet_address: "0xffc458db291b4abce020fe3de4f91f2770e537b1",
  price: 0.05,
};

export const SAMPLE_CHECK_MERCHANT_OUTPUT: CheckMerchantOutput = {
  merchant: "0xffc458db291b4abce020fe3de4f91f2770e537b1",
  network: "eip155:8453",
  recommendation: "PROCEED",
  trust_tier: "TRUSTED",
  confidence: "HIGH",
  data_sufficiency: "SUFFICIENT",
  signals: {
    merchant_age_days: 184,
    unique_payers: 51,
    total_tx_count: 89635,
    payer_concentration: "LOW",
  },
  risk_flags: [],
  reasons: ["Consistent signals across wallet age, payer diversity, and settlement history"],
  price_fairness: "fair",
  pricing: { advertised_prices_atomic: [50000], fairness_vs_category: "fair" },
  category: "data_api",
  chain: "base",
  platforms: [{ url: "https://api.example.com/v1/weather", serviceName: "Weather API" }],
};

/**
 * MCP Server Card (2026-08-19) — "Advanced Integration" quick win, and the
 * *only* one of that tier's 8 items that actually fits this product. The
 * other 7 (OAuth Discovery, OAuth Protected Resource, A2A Agent Card,
 * Skills Index, Web Bot Auth, WebMCP, DNS-AID) were each checked
 * individually against their own "How to implement" caveats and skipped
 * for real reasons, not laziness:
 * - OAuth Discovery / OAuth Protected Resource: both explicitly require
 *   "a working login server" behind them — this has no accounts, no
 *   OAuth, at all (see auth.md). Publishing either would advertise an
 *   auth flow that doesn't exist.
 * - A2A Agent Card / Skills Index: both explicitly "only relevant if your
 *   site runs its own AI agent" — this site doesn't run an autonomous
 *   agent, it's an MCP *tool* other agents call.
 * - Web Bot Auth: for verifying *outbound* bot traffic (a crawler acting
 *   on this site's behalf) is really from this site — there's no such
 *   crawler; the refresh cron's calls to Bazaar/Helius/PayAI are normal
 *   server-to-server API calls, not something needing bot-auth signing.
 * - WebMCP: for exposing *client-side* browser actions (search, add-to-
 *   cart) as agent tools. check_merchant is a paid, server-side,
 *   payment-gated call — exposing it client-side would either not work
 *   or risk a path that bypasses the x402 payment flow entirely, which
 *   directly conflicts with this project's whole monetization model.
 * - DNS-AID: same "not our own agent" reasoning as A2A, plus it requires
 *   DNSSEC changes at the DNS provider — a real, separate infrastructure
 *   decision, not something to bundle into an agent-readiness pass.
 *
 * Cloudflare's scanner checks three candidate paths (confirmed via its
 * own audit log, not guessed) — served identically at all three since
 * there's no single ratified spec URL yet for this convention.
 */
export const MCP_SERVER_CARD_PATHS = [
  "/.well-known/mcp.json",
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp/server-cards.json",
];

export function renderMcpServerCardJson(): string {
  const card = {
    name: "merchant-check-mcp",
    displayName: "x402 Merchant Check",
    description:
      "Pre-payment merchant trust checks for autonomous agents making x402 payments, backed by real on-chain and x402 settlement history on Base and Solana.",
    url: `${MCP_ORIGIN}/mcp`,
    protocol: "mcp",
    transport: "streamable-http",
    protocolVersion: "2025-06-18",
    auth: {
      type: "x402",
      description: "No accounts or API keys — every call is authenticated by an x402 payment, per call. See auth.md.",
      authDoc: `${SITE_ORIGIN}/auth.md`,
    },
    tools: [
      {
        name: "check_merchant",
        description: "Machine-readable trust/pricing assessment for a merchant wallet, before paying it via x402.",
        price: "$0.01 USDC per call, paid via x402 on Base mainnet (eip155:8453)",
        sampleInput: SAMPLE_CHECK_MERCHANT_INPUT,
        sampleOutput: SAMPLE_CHECK_MERCHANT_OUTPUT,
      },
    ],
    links: {
      apiCatalog: `${SITE_ORIGIN}/.well-known/api-catalog`,
      auth: `${SITE_ORIGIN}/auth.md`,
      methodology: `${SITE_ORIGIN}/methodology.md`,
      privacy: `${SITE_ORIGIN}/privacy`,
      stats: SITE_ORIGIN,
    },
  };
  return JSON.stringify(card, null, 2);
}

/**
 * User-agent tokens: only the well-established, stably-documented ones are
 * listed by name (GPTBot, ClaudeBot, Google-Extended, PerplexityBot,
 * Bingbot) rather than guessing at every AI crawler's exact current token,
 * since getting a token wrong silently does nothing rather than erroring.
 * The wildcard block above already covers every crawler regardless —
 * these named blocks are belt-and-suspenders for the "AI-specific bot
 * rules" quick win specifically, not load-bearing on their own.
 *
 * Content-Signal (see https://contentsignals.org / Cloudflare's Content
 * Signals policy): search=yes and ai-input=yes so agents can cite and
 * answer questions about this service (the whole point of publishing it);
 * ai-train=no as the more conservative default for bulk model-training
 * scraping specifically — a real judgment call, not a technical
 * requirement, easy to flip to "yes" here if that's not the intent.
 */
export const ROBOTS_TXT = `# x402 Merchant Check — Gradient Decisions
# This site exists to be used by AI agents (it's a paid MCP tool for them),
# so these rules are permissive by design: crawl and cite freely, just skip
# admin/retired routes that 404 for everyone anyway.

User-agent: *
Allow: /
Disallow: /api/
Disallow: /merchant/
Disallow: /admin/
Disallow: /refresh
Disallow: /categorize
Disallow: /metrics

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Bingbot
Allow: /

Content-Signal: search=yes, ai-input=yes, ai-train=no

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;

/** Only the two real public HTML pages — /mcp is a JSON-RPC endpoint, not crawlable content, and every other route is either 404 or admin-gated. */
export function renderSitemapXml(): string {
  const urls = ["/", "/privacy"];
  const entries = urls.map((path) => `  <url>\n    <loc>${SITE_ORIGIN}${path}</loc>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/** True when the request's Accept header expresses a preference for Markdown over HTML — the same signal Cloudflare's own "Markdown for Agents" feature keys off (Accept: text/markdown), implemented here without needing that Pro-plan feature. */
export function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("text/markdown");
}

/**
 * `/.well-known/api-catalog` (RFC 9727) — "Technical Groundwork" quick win
 * (2026-08-19). A linkset (RFC 9264) document, media type
 * application/linkset+json, pointing agents at the one real machine
 * interface this site has: the MCP endpoint, described by auth.md (how to
 * pay/authenticate) below. Deliberately doesn't invent an OpenAPI spec URL
 * that doesn't exist — check_merchant is an MCP tool, not a REST API, so
 * `describedby` points to prose (auth.md) rather than a fabricated schema
 * document.
 */
export function renderApiCatalogJson(): string {
  const catalog = {
    linkset: [
      {
        anchor: `${MCP_ORIGIN}/mcp`,
        describedby: [
          {
            href: `${SITE_ORIGIN}/auth.md`,
            type: "text/markdown",
            title: "check_merchant MCP tool: payment/auth flow and sample output",
          },
        ],
      },
    ],
  };
  return JSON.stringify(catalog, null, 2);
}

/** Value for the homepage's Link response header (RFC 8288) — the "Link Headers" quick win, pointing agents at the api-catalog above without requiring them to already know it exists. */
export const API_CATALOG_LINK_HEADER = `</.well-known/api-catalog>; rel="api-catalog"`;

/**
 * `/auth.md` — "Technical Groundwork" quick win. Honest about what's
 * actually true here: no accounts, no API keys, no OAuth — x402 payment
 * *is* the auth mechanism, per-call. Includes the canonical sample output
 * above so an agent (or a person) can see the exact shape of what $0.01
 * buys without needing to spend it first, without that sample being real,
 * queryable merchant data — see README "Data access policy" for why real
 * data only ever comes back through an actual paid call.
 */
export function renderAuthMd(): string {
  return `# Auth.md — Authentication

Payment/protocol mechanics only — for how the trust score itself is computed, see [methodology.md](${SITE_ORIGIN}/methodology.md).

x402 Merchant Check has no accounts, no API keys, and no OAuth. There is nothing to register or log into.

Every call to the \`check_merchant\` MCP tool is authenticated by payment itself, per the [x402 protocol](https://x402.org): each request is paid for individually, on-chain, in USDC on Base mainnet. There's no session and no token beyond the payment itself.

## Registration

There is no registration step. No sign-up form, no account creation, no API key issuance, nothing to do in advance. Payment (see below) is the entire authentication mechanism — an agent goes from "never seen this service before" to "successfully authenticated and paid" in one HTTP round-trip.

## How it works

1. Call \`check_merchant\` on \`${MCP_ORIGIN}/mcp\` with a \`merchant_wallet_address\`.
2. Without payment attached, the tool returns an x402 \`402 Payment Required\` challenge (an \`accepts[]\` array with \`scheme\`, \`network\`, \`amount\`, \`asset\`, \`payTo\`).
3. Build and sign a payment matching those exact terms, and retry the same call with it attached. See [x402.org](https://x402.org) or the [@x402/mcp](https://www.npmjs.com/package/@x402/mcp) client library for the mechanics — this server uses the official x402/MCP stack on the server side, not a custom variant.
4. On a valid payment, the tool settles it and returns the real result.

Price: **$0.01 USDC per call**, paid via x402 on Base mainnet (\`eip155:8453\`).

## Sample call and output

Illustrative only — not a live query, not real merchant data. Real results are only ever returned for an actual paid call.

Input:

\`\`\`json
${JSON.stringify(SAMPLE_CHECK_MERCHANT_INPUT, null, 2)}
\`\`\`

Output:

\`\`\`json
${JSON.stringify(SAMPLE_CHECK_MERCHANT_OUTPUT, null, 2)}
\`\`\`

## Machine-readable discovery

- API catalog: [\`/.well-known/api-catalog\`](${SITE_ORIGIN}/.well-known/api-catalog)
- Aggregate stats (no auth needed): [\`${SITE_ORIGIN}/\`](${SITE_ORIGIN}/) (send \`Accept: text/markdown\` for a plain-text version)
`;
}

/**
 * `/methodology.md` (2026-08-19) — added after a direct product question:
 * the landing page's "Read the Docs" button pointed at auth.md, which only
 * explains x402 payment mechanics (how to call/pay/retry). It never
 * explained the actual thing a human clicking "Docs" from a landing page
 * wants to understand first — why the tier/recommendation should be
 * trusted at all. This is that doc: a prose walkthrough of scoring, aimed
 * at a human evaluator, not an integrating agent. auth.md stays exactly as
 * it was (protocol mechanics, agent-facing) — this doesn't replace it,
 * they're cross-linked.
 *
 * Every number/threshold/signal description below is pulled directly from
 * src/scoring.ts and src/tool.ts, not paraphrased from memory — including
 * the honest bits (two of six signals are currently dormant, one is
 * stubbed). If those files' thresholds change, this doc goes stale; there's
 * no shared-constant mechanism forcing the two to match (scoring.ts's
 * constants are all internal, not exported for display purposes), so it's
 * on whoever changes scoring.ts next to also update this file's prose.
 */
export function renderMethodologyMd(): string {
  return `# Methodology — How check_merchant Scores Trust

This is a rules-based v1 scoring system, not a machine-learning model and not a certification. Every signal below maps to something specific and inspectable; nothing here is a black-box number. If you want the payment/auth mechanics instead of the scoring logic, see [auth.md](${SITE_ORIGIN}/auth.md).

## What it's built from

Only two kinds of data feed this: a merchant wallet's **observable on-chain settlement history**, and its **x402 activity** (what it charges, how often it's paid, by how many distinct payers). Nothing here is self-reported, manually reviewed, or sourced from off-chain reputation — a merchant can't improve its own score by filling out a form.

## The six signals

Every real finding below adds one entry to \`reasons\` and one matching code to \`risk_flags\`. Two of the six are currently dormant (no data source populates them yet), and one is stubbed — that's stated here plainly, not glossed over.

1. **Wallet age.** Flags wallets younger than 14 days. A merchant that's only existed for a few days has no track record to speak of, independent of anything else about it.
2. **Payer diversity.** Compares unique payers against total transaction count. Below a 0.3 ratio, volume looks concentrated among very few payers — a pattern consistent with wash volume. There's one override: a wallet with 50 or more distinct payers skips this check regardless of ratio, because a high-frequency-use API (an agent search endpoint an agent might call dozens of times per session) naturally drives the ratio down without any real concentration risk. Both numbers — the 0.3 ratio and the 50-payer floor — are calibrated against real production data, not guessed: the ratio was checked against 365 live merchants (the one confirmed "avoid" case sits at 0.05; "trusted" wallets average 0.56), and the 50-payer floor sits comfortably under where real PROCEED-tier merchants top out, while still being expensive to fake — reaching 50 distinct wallets that each made a real payment isn't cheap to fabricate.
3. **Settlement completion.** *(Currently dormant on both chains — neither data source this service ingests from populates completed/abandoned flow counts yet.)* Once live, this flags a merchant whose quote→pay→deliver flow gets abandoned more than 35% of the time.
4. **Refund / recourse.** Flags a merchant with zero refunds despite meaningful volume (20+ transactions) and nonzero refund-eligible volume — zero refunds at real volume isn't automatically suspicious, but it is a visible absence of recourse worth surfacing.
5. **Price consistency.** *(Currently dormant on both chains — same reason as signal 3: no ingested source populates per-payer price observations yet.)* Once live, this flags a merchant charging different requesters different prices for the identical resource.
6. **Velocity / anomaly detection.** *(Stubbed — not yet implemented on either chain.)* Meant to catch anomalous spikes in volume or transaction size. Deliberately not live yet: Solana settles roughly 4x faster than Base, and a threshold tuned on Base activity would over-flag entirely normal Solana usage. This gets implemented chain-aware, not retrofit after the fact.

## From signals to a tier

The rule is a direct count, not a weighted score: zero signals fired → **trusted**. Exactly one → **caution**. Two or more → **avoid**. A wallet that clears every check gets one explicit positive reason recorded too ("Consistent signals across wallet age, payer diversity, and settlement history"), not just a bare "nothing wrong found."

## From tier to recommendation

\`trust_tier\` (TRUSTED/CAUTION/AVOID) is the detailed read; \`recommendation\` (PROCEED/CAUTION/INSUFFICIENT_SIGNAL) is the smaller, deterministic vocabulary an agent's payment policy is meant to switch on directly. They're not the same axis:

- Fewer than 5 transactions total → **INSUFFICIENT_SIGNAL**, regardless of tier. This is a data gap, not a behavioral finding — a wallet with too little history to say anything gets told exactly that, not defaulted into a false "caution."
- 5 or more transactions, tier is trusted → **PROCEED**.
- 5 or more transactions, tier is caution or avoid → **CAUTION**.

There's no REJECT or BLOCK value. Nothing in this pipeline currently produces evidence strong enough to justify a hard block — adding one without that evidence would just be a stronger-sounding guess than the data supports.

## Confidence and payer concentration

\`confidence\` is graduated separately from the sufficiency gate above: HIGH at 50+ transactions, MEDIUM at 15+, LOW below that. A wallet can clear the 5-transaction sufficiency bar and still only warrant LOW confidence.

\`payer_concentration\` (LOW/MEDIUM/HIGH) is derived from the same diversity ratio and 50-payer breadth override as signal 2 above — deliberately reusing the identical numbers, so this field can never say HIGH concentration while \`risk_flags\` stays silent on it.

## Price fairness

When a caller supplies a price (or the merchant has its own advertised price on file), it's compared against the median of comparable prices from other merchants in the same category: 3x the median or higher is **high**, 0.35x or lower is **low**, otherwise **fair**. Fewer than 3 comparable prices in that category returns **unknown** rather than a forced answer. These bands come from real observed spread across six categories and roughly 400 priced merchants, not an arbitrary percentage — categories like "data_api" bundle genuinely different resources at genuinely different price points, so the bands are wider than a single-product market would need.

## Known limitations

Stated plainly, not buried:

- Two of the six signals (settlement completion, price consistency) are currently dormant on both chains — no ingested data source populates them yet.
- The velocity/anomaly signal is stubbed entirely, and will need chain-specific tuning before it's safe to enable (see signal 6 above).
- The payer-diversity ratio and its 50-payer override are calibrated against real Base data only; Solana's own payer-diversity distribution hasn't yet been separately validated.
- Category price-fairness bands are grounded in real data but still coarse — six categories cover a wide range of actual resource types.

None of this is a certification of any merchant's legitimacy. It's an algorithmic read of public, observable signals — decision support for an agent's own payment policy, not a substitute for it.
`;
}

function pct(n: number, denom: number): number {
  return denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0;
}
function chainTotal(c: RecommendationCounts): number {
  return c.proceed + c.caution + c.insufficientSignal;
}
function relativeTime(unixSeconds: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

/** Markdown counterpart to src/homePlaceholder.ts's HTML render — same underlying DashboardSummary, no separate data fetch, so the two can never disagree. */
export function renderHomeMarkdown(summary: DashboardSummary): string {
  const { counts, countsByChain, total, lastRefreshedAt } = summary;
  const baseTotal = chainTotal(countsByChain.base);
  const solanaTotal = chainTotal(countsByChain.solana);

  return `# x402 Merchant Check

Pre-payment merchant intelligence for autonomous agents making x402 payments. Before paying an unfamiliar merchant, an agent calls \`check_merchant\` and gets back a trust recommendation built from that merchant's observable on-chain and x402 activity.

## Live stats

- Merchants indexed: ${total}
- Proceed: ${counts.proceed} (${pct(counts.proceed, total)}%)
- Caution: ${counts.caution} (${pct(counts.caution, total)}%)
- Insufficient signal: ${counts.insufficientSignal} (${pct(counts.insufficientSignal, total)}%)
- Base: ${baseTotal} merchants, ${pct(countsByChain.base.proceed, baseTotal)}% proceed
- Solana: ${solanaTotal} merchants, ${pct(countsByChain.solana.proceed, solanaTotal)}% proceed

Last refreshed: ${lastRefreshedAt ? relativeTime(lastRefreshedAt) : "never"}. Aggregate counts only — per-merchant results are available via the paid \`check_merchant\` MCP tool.

## For agents

- MCP endpoint: \`mcp.gradientdecisions.com/mcp\`
- Tool: \`check_merchant\` — $0.01 per query, paid via x402 on Base mainnet.

## Links

- [Privacy policy](${SITE_ORIGIN}/privacy)
`;
}
