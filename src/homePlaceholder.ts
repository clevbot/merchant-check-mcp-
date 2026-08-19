/**
 * Public homepage (`/` and `/dashboard`), rewritten 2026-08-19 to stop
 * serving the full live dashboard. See README "Data access policy" for the
 * full reasoning: the old version rendered every scored merchant's
 * recommendation/signals/pricing directly in the page, and `/api/wallets`
 * served the same data as raw JSON, both for free — an agent (or anyone
 * scripting against either) could get the exact same read `check_merchant`
 * sells for $0.01/query without ever paying for it, which undercut the
 * paid MCP tool that is this product's actual business.
 *
 * Added back 2026-08-19 at the user's request: aggregate-only summary
 * stats (total merchants, PROCEED/CAUTION/INSUFFICIENT_SIGNAL counts, and
 * the same split by chain) — genuinely safe to publish for free, since
 * none of it lets a caller look up any specific merchant's trust status
 * the way the old dashboard, `/api/wallets`, or the retired `/merchant/*`
 * profile pages did. Computed by src/dashboard.ts's getDashboardSummary(),
 * which queries only (chain, tier, total_tx_count) — no wallet address, no
 * per-merchant data ever leaves D1 for this page. The real redesigned
 * homepage/dashboard UI is still a separate, later task from Figma
 * mockups — this stays a lightweight stats page until then, not the full
 * per-merchant table.
 */
import type { DashboardSummary, RecommendationCounts } from "./dashboard";
import { BRAND_CSS, FAVICON_LINK, FONT_LINKS, renderMonogram, renderWordmark } from "./brand";

function relativeTime(unixSeconds: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const pct = (n: number, denom: number) => (denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0);
const chainTotal = (c: RecommendationCounts) => c.proceed + c.caution + c.insufficientSignal;

export function renderHomePlaceholderHtml(summary: DashboardSummary): string {
  const { counts, countsByChain, total, lastRefreshedAt } = summary;
  const baseTotal = chainTotal(countsByChain.base);
  const solanaTotal = chainTotal(countsByChain.solana);

  return `<title>x402 Merchant Check | Gradient Decisions</title>
<meta name="description" content="Pre-payment merchant trust checks for x402 agents, via the check_merchant MCP tool.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FONT_LINKS}
<style>
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280; --accent: #4f46e5;
    --proceed: #16a34a; --proceed-bg: #dcfce7; --caution: #b45309; --caution-bg: #fef3c7;
    --insufficient: #6b7280; --insufficient-bg: #f1f1f3;
    --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0d; --surface: #17171a; --border: #2a2a2e; --text: #f4f4f5; --text-dim: #9ca3af; --accent: #818cf8;
      --proceed: #4ade80; --proceed-bg: #14532d; --caution: #fbbf24; --caution-bg: #78350f;
      --insufficient: #9ca3af; --insufficient-bg: #27272a;
      --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    line-height: 1.6;
  }
  ${BRAND_CSS}
  .wrap { max-width: 640px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  .topbar { height: 3px; background: var(--brand-gradient); margin: -3rem -1.5rem 2rem; }
  .brand-row { display: flex; align-items: center; gap: .6rem; margin-bottom: 1.25rem; }
  .brand-row .brand-mark { width: 32px; }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  p { font-size: .95rem; color: var(--text-dim); }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 1.25rem 1.4rem; margin: 1.5rem 0;
  }
  .card h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin: 0 0 .6rem; }
  .card p { color: var(--text); margin: 0 0 .5rem; }
  .card p:last-child { margin-bottom: 0; }
  code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: .15rem .4rem; font-size: .85rem; }
  a { color: var(--accent); }
  footer { margin-top: 2.5rem; color: var(--text-dim); font-size: .82rem; }
  .footer-brand { opacity: .55; margin-bottom: .85rem; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .65rem; margin: 1.5rem 0 1rem; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: .9rem 1rem; box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  .stat-card .n { font-size: 1.4rem; font-weight: 650; }
  .stat-card .label { font-size: .74rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .03em; }
  .stat-card.proceed .n { color: var(--proceed); }
  .stat-card.caution .n { color: var(--caution); }
  .stat-card.insufficient .n { color: var(--insufficient); }
  .bars { display: flex; height: 8px; border-radius: 6px; overflow: hidden; margin-bottom: 1.5rem; border: 1px solid var(--border); }
  .bar-proceed { background: var(--proceed); }
  .bar-caution { background: var(--caution); }
  .bar-insufficient { background: var(--insufficient); }
  .chain-breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .65rem; margin-bottom: .5rem; }
  .chain-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: .8rem .95rem; }
  .chain-card .chain-title { font-size: .74rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin-bottom: .35rem; }
  .chain-card .chain-stats { display: flex; gap: .85rem; font-size: .82rem; }
  .chain-card .chain-stats b { font-variant-numeric: tabular-nums; color: var(--proceed); }
  .refreshed-note { font-size: .78rem; color: var(--text-dim); margin: -.25rem 0 0; }
</style>
<div class="topbar"></div>
<div class="wrap">
  <div class="brand-row">${renderMonogram("home-header", 32)}<h1>x402 Merchant Check</h1></div>
  <p>
    Pre-payment merchant intelligence for autonomous agents making x402 payments:
    before paying an unfamiliar merchant, an agent calls <code>check_merchant</code> and gets back a
    trust recommendation built from that merchant's observable on-chain and x402 activity.
  </p>

  <div class="stats">
    <div class="stat-card"><div class="n">${total.toLocaleString()}</div><div class="label">Merchants indexed</div></div>
    <div class="stat-card proceed"><div class="n">${counts.proceed}</div><div class="label">Proceed (${pct(counts.proceed, total)}%)</div></div>
    <div class="stat-card caution"><div class="n">${counts.caution}</div><div class="label">Caution (${pct(counts.caution, total)}%)</div></div>
    <div class="stat-card insufficient"><div class="n">${counts.insufficientSignal}</div><div class="label">Insufficient signal (${pct(counts.insufficientSignal, total)}%)</div></div>
  </div>
  <div class="bars">
    <div class="bar-proceed" style="width:${pct(counts.proceed, total)}%"></div>
    <div class="bar-caution" style="width:${pct(counts.caution, total)}%"></div>
    <div class="bar-insufficient" style="width:${pct(counts.insufficientSignal, total)}%"></div>
  </div>

  <div class="chain-breakdown">
    <div class="chain-card">
      <div class="chain-title">Base</div>
      <div class="chain-stats">
        <span>${baseTotal.toLocaleString()} merchants</span>
        <span><b>${pct(countsByChain.base.proceed, baseTotal)}%</b> proceed</span>
      </div>
    </div>
    <div class="chain-card">
      <div class="chain-title">Solana</div>
      <div class="chain-stats">
        <span>${solanaTotal.toLocaleString()} merchants</span>
        <span><b>${pct(countsByChain.solana.proceed, solanaTotal)}%</b> proceed</span>
      </div>
    </div>
  </div>
  <p class="refreshed-note">Last refreshed ${lastRefreshedAt ? relativeTime(lastRefreshedAt) : "never"}. Aggregate counts only — per-merchant results are available via the paid <code>check_merchant</code> MCP tool.</p>

  <div class="card">
    <h2>For agents</h2>
    <p>MCP endpoint: <code>mcp.gradientdecisions.com/mcp</code></p>
    <p>Tool: <code>check_merchant</code> — $0.01 per query, paid via x402 on Base mainnet.</p>
  </div>

  <footer>
    <div class="footer-brand">${renderWordmark("home-footer", 120)}</div>
    <a href="/privacy">Privacy policy</a>.
  </footer>
</div>`;
}
