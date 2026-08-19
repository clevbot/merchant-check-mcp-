/**
 * Minimal static homepage (2026-08-19), replacing the previous full live
 * dashboard at `/` and `/dashboard`. See README "Data access policy" for
 * the full reasoning: the old dashboard rendered every scored merchant's
 * recommendation/signals/pricing directly in the page, and `/api/wallets`
 * served the same data as raw JSON, both for free — an agent (or anyone
 * scripting against either) could get the exact same read `check_merchant`
 * sells for $0.01/query without ever paying for it, which undercut the
 * paid MCP tool that is this product's actual business.
 *
 * Deliberately static: no D1 query, no per-merchant data, nothing to leak.
 * This is an explicit placeholder, not the real homepage — the redesigned
 * homepage/dashboard UI is being built separately from Figma mockups (not
 * this task); this file's only job until then is to stop serving the full
 * dataset while still being a real, working page rather than a blank one.
 */
import { BRAND_CSS, FAVICON_LINK, FONT_LINKS, renderMonogram, renderWordmark } from "./brand";

export function renderHomePlaceholderHtml(): string {
  return `<title>x402 Merchant Check | Gradient Decisions</title>
<meta name="description" content="Pre-payment merchant trust checks for x402 agents, via the check_merchant MCP tool.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FONT_LINKS}
<style>
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280; --accent: #4f46e5;
    --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0d; --surface: #17171a; --border: #2a2a2e; --text: #f4f4f5; --text-dim: #9ca3af; --accent: #818cf8;
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
</style>
<div class="topbar"></div>
<div class="wrap">
  <div class="brand-row">${renderMonogram("home-header", 32)}<h1>x402 Merchant Check</h1></div>
  <p>
    Pre-payment merchant intelligence for autonomous agents making x402 payments:
    before paying an unfamiliar merchant, an agent calls <code>check_merchant</code> and gets back a
    trust recommendation built from that merchant's observable on-chain and x402 activity.
  </p>

  <div class="card">
    <h2>For agents</h2>
    <p>MCP endpoint: <code>mcp.gradientdecisions.com/mcp</code></p>
    <p>Tool: <code>check_merchant</code> — $0.01 per query, paid via x402 on Base mainnet.</p>
  </div>

  <div class="card">
    <h2>For humans</h2>
    <p>A browsable dashboard for this data is on the way. In the meantime, questions can go to
      <a href="/privacy">the privacy policy</a>'s contact address.</p>
  </div>

  <footer>
    <div class="footer-brand">${renderWordmark("home-footer", 120)}</div>
    <a href="/privacy">Privacy policy</a>.
  </footer>
</div>`;
}
