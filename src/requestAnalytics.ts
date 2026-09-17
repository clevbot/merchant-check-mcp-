/**
 * Internal request-funnel dashboard — added 2026-09-17 after a direct
 * report: "we have seen a significant rise in invocations but i dont
 * think any payments have been made... create a dashboard... where they
 * come from, what they are looking for, and why they arent paying."
 *
 * Confirmed via direct D1 queries and the Cloudflare dashboard before
 * building this: invocations were up 614% over 30 days (136.82k) while
 * query_log (settled calls) stayed flat at 37 rows, unchanged in weeks.
 * query_log's own comment already named the gap this fills: "it cannot
 * see how many 402 challenges were issued that never converted... needs
 * instrumentation earlier in the x402 handshake." src/index.ts's
 * logMcpRequest and the extended onVerifyFailure hook are that
 * instrumentation (writing to db/schema.sql's request_events); this file
 * is the dashboard on top of it.
 *
 * Revised same day, hours after shipping: the first version only logged
 * unpaid check_merchant attempts and still showed near-zero data against
 * a live traffic firehose. Direct inspection of a real request (a 46-byte
 * POST /mcp body — too small for a check_merchant call) showed why: most
 * /mcp traffic is MCP-level discovery (initialize, tools/list, ping) from
 * directories/crawlers that never call the paid tool at all. The "paid
 * tool" funnel (challenge/verify/settled) and general protocol traffic
 * are now reported separately below, not conflated — see
 * RequestAnalytics.protocolCallCount's own comment for why.
 *
 * Same internal-only posture as src/callerDashboard.ts: admin-token
 * gated (see src/index.ts GET /admin/requests), not linked from the
 * public site, matching visual style (this is a debugging tool, not the
 * public brand). Same no-identity-resolution principle too — caller_ip/
 * user_agent/asn/country are for spotting bot/crawler *patterns* (shared
 * UA, shared ASN), never resolved to a person.
 */
import type { RequestAnalytics } from "./db/queries";
import { escapeHtml, truncateAddress } from "./dashboard";
import { BRAND_CSS, FAVICON_LINK, renderMonogram } from "./brand";

function pct(n: number, denom: number): string {
  return denom > 0 ? `${((n / denom) * 100).toFixed(1)}%` : "—";
}

function relativeTime(unixSeconds: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function renderRequestAnalyticsHtml(data: RequestAnalytics): string {
  const { funnel, protocolCallCount, topMcpMethods, topUserAgents, topAsOrganizations, topCountries, topRequestedWallets, dailyFunnel, recentEvents } = data;
  const totalAttempts = funnel.challengeIssued + funnel.verifyFailed + funnel.settled;
  const totalMcpTraffic = totalAttempts + protocolCallCount;

  const dailyRows = dailyFunnel
    .map(
      (d) => `<tr>
        <td>${escapeHtml(d.day)}</td>
        <td class="num">${d.challengeIssued.toLocaleString()}</td>
        <td class="num">${d.verifyFailed.toLocaleString()}</td>
        <td class="num settled">${d.settled.toLocaleString()}</td>
      </tr>`,
    )
    .join("\n");

  const topTable = (rows: { value: string; count: number }[]) =>
    rows.length === 0
      ? `<tr><td colspan="2">No data in window.</td></tr>`
      : rows
          .map((r) => `<tr><td title="${escapeHtml(r.value)}">${escapeHtml(r.value.length > 70 ? r.value.slice(0, 70) + "…" : r.value)}</td><td class="num">${r.count.toLocaleString()}</td></tr>`)
          .join("\n");

  const walletRows = topRequestedWallets
    .map((r) => `<tr><td><code title="${escapeHtml(r.value)}">${escapeHtml(truncateAddress(r.value))}</code></td><td class="num">${r.count.toLocaleString()}</td></tr>`)
    .join("\n");

  const recentRows = recentEvents
    .map((e) => {
      const cls = e.eventType === "verify_failed" ? "verify-failed" : e.eventType === "protocol_call" ? "protocol" : "challenge";
      const eventLabel = e.eventType === "protocol_call" ? `protocol_call (${escapeHtml(e.mcpMethod ?? "unknown")})` : escapeHtml(e.eventType);
      return `<tr class="${cls}">
        <td>${relativeTime(e.occurredAt)}</td>
        <td>${escapeHtml(e.path)}</td>
        <td>${eventLabel}</td>
        <td>${e.queriedWalletAddress ? `<code title="${escapeHtml(e.queriedWalletAddress)}">${escapeHtml(truncateAddress(e.queriedWalletAddress))}</code>` : "—"}</td>
        <td title="${e.asOrganization ? escapeHtml(e.asOrganization) : ""}">${e.country ? escapeHtml(e.country) : "—"}</td>
        <td class="ua" title="${e.userAgent ? escapeHtml(e.userAgent) : ""}">${e.userAgent ? escapeHtml(e.userAgent.length > 50 ? e.userAgent.slice(0, 50) + "…" : e.userAgent) : "—"}</td>
        <td class="err" title="${e.verifyError ? escapeHtml(e.verifyError) : ""}">${e.verifyError ? escapeHtml(e.verifyError.length > 40 ? e.verifyError.slice(0, 40) + "…" : e.verifyError) : "—"}</td>
      </tr>`;
    })
    .join("\n");

  return `<title>Internal | Request Analytics</title>
<meta name="robots" content="noindex, nofollow">
${FAVICON_LINK}
<style>
  :root { --text: #e4e4e7; --accent: #818cf8; --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%); }
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, SFMono-Regular, monospace; background: #0b0b0d; color: #e4e4e7; margin: 0; padding: 2rem; }
  .topbar { height: 3px; background: var(--brand-gradient); margin: -2rem -2rem 1.75rem; }
  .brand-row { display: flex; align-items: center; gap: .55rem; margin-bottom: 1rem; color: #e4e4e7; }
  .brand-row .brand-mark { width: 22px; }
  .brand-row span { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; }
  h1, h2 { font-weight: 600; }
  h1 { font-size: 1.2rem; margin: 0 0 .75rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #9ca3af; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .4rem .7rem; border-bottom: 1px solid #27272a; font-size: .82rem; }
  th { color: #9ca3af; text-transform: uppercase; font-size: .7rem; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.settled { color: #4ade80; }
  tr.verify-failed td.err { color: #f87171; }
  tr.protocol td { color: #71717a; }
  td.ua, td.err { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stats { display: flex; gap: 1.5rem; margin: 1rem 0; flex-wrap: wrap; }
  .stat b { font-size: 1.3rem; display: block; color: var(--accent); }
  .stat.settled b { color: #4ade80; }
  .stat.failed b { color: #f87171; }
  .note { color: #6b7280; font-size: .78rem; max-width: 80ch; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .overflow { overflow-x: auto; }
  ${BRAND_CSS}
</style>
<div class="topbar"></div>
<div class="brand-row">${renderMonogram("req-header", 22)}<span>Gradient Decisions, Internal</span></div>
<h1>Request funnel analytics</h1>
<p class="note">
  Internal only, not linked from the public site. Two separate measurements below, not one funnel:
  general MCP protocol traffic hitting /mcp (initialize, tools/list, ping, ...) — mostly directory/
  crawler discovery that never asks for the paid tool at all — and the actual check_merchant
  payment funnel (challenge issued with no payment yet → payment attached but rejected at
  verification → real settled call). "Settled" comes from query_log; everything else comes from
  request_events, added specifically to answer "why aren't they paying."
</p>

<h2 style="margin-top:1rem;">MCP protocol traffic (not attempts to use the paid tool)</h2>
<div class="stats">
  <div class="stat"><b>${totalMcpTraffic.toLocaleString()}</b>total /mcp requests (window)</div>
  <div class="stat"><b>${protocolCallCount.toLocaleString()}</b>protocol calls, no tool invoked (${pct(protocolCallCount, totalMcpTraffic)})</div>
</div>
<table><thead><tr><th>MCP method</th><th class="num">Count</th></tr></thead><tbody>${topTable(topMcpMethods)}</tbody></table>

<h2>check_merchant payment funnel</h2>
<div class="stats">
  <div class="stat"><b>${totalAttempts.toLocaleString()}</b>total attempts (window)</div>
  <div class="stat"><b>${funnel.challengeIssued.toLocaleString()}</b>challenge issued, no payment (${pct(funnel.challengeIssued, totalAttempts)})</div>
  <div class="stat failed"><b>${funnel.verifyFailed.toLocaleString()}</b>payment attached, verify failed (${pct(funnel.verifyFailed, totalAttempts)})</div>
  <div class="stat settled"><b>${funnel.settled.toLocaleString()}</b>settled (${pct(funnel.settled, totalAttempts)})</div>
</div>

<h2>Daily funnel</h2>
<div class="overflow">
<table><thead><tr><th>Day</th><th class="num">Challenge issued</th><th class="num">Verify failed</th><th class="num">Settled</th></tr></thead>
<tbody>${dailyRows || "<tr><td colspan=4>No data in window.</td></tr>"}</tbody></table>
</div>

<h2>Where it's coming from</h2>
<div class="grid2">
  <div>
    <h2 style="margin-top:0;font-size:.85rem;">Top user agents</h2>
    <table><thead><tr><th>User agent</th><th class="num">Count</th></tr></thead><tbody>${topTable(topUserAgents)}</tbody></table>
  </div>
  <div>
    <h2 style="margin-top:0;font-size:.85rem;">Top networks (ASN org)</h2>
    <table><thead><tr><th>Organization</th><th class="num">Count</th></tr></thead><tbody>${topTable(topAsOrganizations)}</tbody></table>
  </div>
  <div>
    <h2 style="margin-top:0;font-size:.85rem;">Top countries</h2>
    <table><thead><tr><th>Country</th><th class="num">Count</th></tr></thead><tbody>${topTable(topCountries)}</tbody></table>
  </div>
</div>

<h2>What they're looking for (most-requested merchant wallets)</h2>
<table><thead><tr><th>Merchant wallet</th><th class="num">Requests</th></tr></thead><tbody>${walletRows || "<tr><td colspan=2>No data in window.</td></tr>"}</tbody></table>

<h2>Recent raw events (up to 200, newest first)</h2>
<p class="note">Red rows are real payment attempts that failed verification — hover the Reason column for the full facilitator error. Gray rows are general MCP protocol calls (never asked for the paid tool at all). Everything else is a bare, unpaid check_merchant call.</p>
<div class="overflow">
<table><thead><tr><th>When</th><th>Path</th><th>Event</th><th>Wallet asked about</th><th>Country</th><th>User agent</th><th>Reason (if failed)</th></tr></thead>
<tbody>${recentRows || "<tr><td colspan=7>No data in window.</td></tr>"}</tbody></table>
</div>`;
}

/** JSON API for this same data — for scripted analysis rather than eyeballing the HTML, same pattern as callerAnalyticsToJson. */
export function requestAnalyticsToJson(data: RequestAnalytics): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
