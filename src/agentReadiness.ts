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
  return `# Authentication

x402 Merchant Check has no accounts, no API keys, and no OAuth. There is nothing to register or log into.

Every call to the \`check_merchant\` MCP tool is authenticated by payment itself, per the [x402 protocol](https://x402.org): each request is paid for individually, on-chain, in USDC on Base mainnet. There's no session and no token beyond the payment itself.

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
