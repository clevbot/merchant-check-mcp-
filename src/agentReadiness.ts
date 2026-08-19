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

const SITE_ORIGIN = "https://gradientdecisions.com";

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
