/**
 * Internal caller-tracking dashboard — tracks usage of check_merchant
 * itself (who's calling it, how often, what they're checking), separate
 * from the public merchant-scoring dashboard (src/dashboard.ts). Added
 * 2026-08-13 per direct request: "this caller data is confirmed-intent
 * ground truth (a wallet paying to check a merchant is actively evaluating
 * a real purchase), intended to eventually inform buyer-side behavioral
 * segmentation, not just merchant scoring." That segmentation work is NOT
 * built here — this module only builds the tracking/aggregation
 * infrastructure the brief asked for; segmentation logic is explicitly
 * future work, not implied to exist by this file.
 *
 * Internal only — gated behind ADMIN_TOKEN in src/index.ts (GET
 * /admin/callers), same mechanism as /refresh, /categorize, /metrics. Not
 * linked from the public site, not served at a guessable public path the
 * way the merchant-tier dashboard is.
 *
 * No-identity-resolution principle (explicit design constraint, matches
 * every other module in this project): every aggregate below is keyed on
 * `payer_address` — the on-chain wallet that paid for the check — and
 * nothing here attempts to resolve that address to any off-chain identity
 * (an email, an account, a person). If that's ever wanted, it's a separate,
 * deliberate decision this file does not make on its own.
 */

import type { Env } from "./types";
import { escapeHtml } from "./dashboard";

export interface CallerFrequencyRow {
  payer_address: string;
  query_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface CategoryCount {
  category: string | null;
  count: number;
}

export interface DailyUniqueCallers {
  day: string; // YYYY-MM-DD
  unique_callers: number;
}

export interface CallerAnalytics {
  windowSeconds: number;
  /** Every wallet that has ever paid to call check_merchant, most-active first. Capped at 500 rows — this is an internal debugging/analysis view, not a paginated report. */
  callerFrequency: CallerFrequencyRow[];
  /** Distinct payer_address count within the window — the top-line "how many real callers" number. */
  uniqueCallersInWindow: number;
  totalQueriesInWindow: number;
  categoryDistribution: CategoryCount[];
  dailyUniqueCallers: DailyUniqueCallers[];
  /**
   * "Wallets that queried more than once in a rolling 30-day window" — the
   * literal ask. retainedCallers = distinct payer_address with >=2 queries
   * inside the last 30 days from now; totalCallers30d = distinct
   * payer_address with >=1 query in that same window. retentionRate is
   * retained/total, 0 if totalCallers30d is 0 (not NaN — an empty window
   * has no meaningful retention rate, not a divide-by-zero to hide).
   */
  retainedCallers30d: number;
  totalCallers30d: number;
  retentionRate30d: number;
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export async function getCallerAnalytics(env: Env, windowSeconds: number): Promise<CallerAnalytics> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - windowSeconds;
  const since30d = now - THIRTY_DAYS_SECONDS;

  const { results: freqRows } = await env.DB.prepare(
    `SELECT payer_address, COUNT(*) as query_count, MIN(queried_at) as first_seen_at, MAX(queried_at) as last_seen_at
     FROM query_log
     WHERE payer_address IS NOT NULL
     GROUP BY payer_address
     ORDER BY query_count DESC
     LIMIT 500`,
  ).all<CallerFrequencyRow>();

  const { results: windowCountRows } = await env.DB.prepare(
    `SELECT COUNT(DISTINCT payer_address) as unique_callers, COUNT(*) as total
     FROM query_log WHERE payer_address IS NOT NULL AND queried_at >= ?`,
  )
    .bind(since)
    .all<{ unique_callers: number; total: number }>();

  const { results: categoryRows } = await env.DB.prepare(
    `SELECT queried_category as category, COUNT(*) as count
     FROM query_log WHERE queried_at >= ?
     GROUP BY queried_category ORDER BY count DESC`,
  )
    .bind(since)
    .all<CategoryCount>();

  // SQLite's strftime with a unixepoch modifier — same "compute on read,
  // not maintained incrementally" tradeoff as getMetricsSummary (this is
  // admin/reporting traffic, not the hot paid request path).
  const { results: dailyRows } = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', queried_at, 'unixepoch') as day, COUNT(DISTINCT payer_address) as unique_callers
     FROM query_log WHERE payer_address IS NOT NULL AND queried_at >= ?
     GROUP BY day ORDER BY day`,
  )
    .bind(since)
    .all<DailyUniqueCallers>();

  const { results: retentionRows } = await env.DB.prepare(
    `SELECT
       COUNT(*) as total_callers,
       SUM(CASE WHEN query_count >= 2 THEN 1 ELSE 0 END) as retained_callers
     FROM (
       SELECT payer_address, COUNT(*) as query_count
       FROM query_log
       WHERE payer_address IS NOT NULL AND queried_at >= ?
       GROUP BY payer_address
     )`,
  )
    .bind(since30d)
    .all<{ total_callers: number; retained_callers: number }>();

  const totalCallers30d = retentionRows[0]?.total_callers ?? 0;
  const retainedCallers30d = retentionRows[0]?.retained_callers ?? 0;

  return {
    windowSeconds,
    callerFrequency: freqRows,
    uniqueCallersInWindow: windowCountRows[0]?.unique_callers ?? 0,
    totalQueriesInWindow: windowCountRows[0]?.total ?? 0,
    categoryDistribution: categoryRows,
    dailyUniqueCallers: dailyRows,
    retainedCallers30d,
    totalCallers30d,
    retentionRate30d: totalCallers30d > 0 ? retainedCallers30d / totalCallers30d : 0,
  };
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

/** Minimal, internal-only styling — deliberately not the polished public dashboard (see module comment: this isn't meant to be public-facing). */
export function renderCallerDashboardHtml(data: CallerAnalytics): string {
  const {
    callerFrequency,
    uniqueCallersInWindow,
    totalQueriesInWindow,
    categoryDistribution,
    dailyUniqueCallers,
    retainedCallers30d,
    totalCallers30d,
    retentionRate30d,
  } = data;

  const freqRows = callerFrequency
    .map(
      (r) => `<tr>
        <td><code title="${escapeHtml(r.payer_address)}">${escapeHtml(truncateAddress(r.payer_address))}</code></td>
        <td class="num">${r.query_count.toLocaleString()}</td>
        <td>${new Date(r.first_seen_at * 1000).toISOString().slice(0, 10)}</td>
        <td>${new Date(r.last_seen_at * 1000).toISOString().slice(0, 10)}</td>
      </tr>`,
    )
    .join("\n");

  const categoryRows = categoryDistribution
    .map(
      (c) => `<tr><td>${escapeHtml(c.category ?? "(none / uncategorized)")}</td><td class="num">${c.count.toLocaleString()}</td></tr>`,
    )
    .join("\n");

  const dailyRows = dailyUniqueCallers
    .map((d) => `<tr><td>${escapeHtml(d.day)}</td><td class="num">${d.unique_callers.toLocaleString()}</td></tr>`)
    .join("\n");

  return `<title>Internal — Caller Analytics</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { font-family: ui-monospace, SFMono-Regular, monospace; background: #0b0b0d; color: #e4e4e7; padding: 2rem; }
  h1, h2 { font-weight: 600; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #9ca3af; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .4rem .7rem; border-bottom: 1px solid #27272a; font-size: .82rem; }
  th { color: #9ca3af; text-transform: uppercase; font-size: .7rem; }
  td.num { text-align: right; }
  .stats { display: flex; gap: 1.5rem; margin: 1rem 0; }
  .stat b { font-size: 1.3rem; display: block; }
  .note { color: #6b7280; font-size: .78rem; max-width: 70ch; }
</style>
<h1>Internal — check_merchant caller analytics</h1>
<p class="note">
  Internal only, not linked from the public site. Tracks wallet-level usage of check_merchant
  itself — who's paying to check merchants, how often, what categories — as confirmed-intent
  ground truth (a wallet paying to check a merchant is actively evaluating a real purchase).
  No off-chain identity resolution: every row here is a wallet address, nothing more.
</p>

<div class="stats">
  <div class="stat"><b>${uniqueCallersInWindow.toLocaleString()}</b>unique callers (window)</div>
  <div class="stat"><b>${totalQueriesInWindow.toLocaleString()}</b>total queries (window)</div>
  <div class="stat"><b>${(retentionRate30d * 100).toFixed(1)}%</b>30d retention (${retainedCallers30d}/${totalCallers30d} callers with 2+ queries)</div>
</div>

<h2>Daily unique callers</h2>
<table><thead><tr><th>Day</th><th class="num">Unique callers</th></tr></thead><tbody>${dailyRows || "<tr><td colspan=2>No data in window.</td></tr>"}</tbody></table>

<h2>Category distribution (what's being checked)</h2>
<table><thead><tr><th>Category</th><th class="num">Queries</th></tr></thead><tbody>${categoryRows || "<tr><td colspan=2>No data in window.</td></tr>"}</tbody></table>

<h2>Caller frequency (all time, top 500 by query count)</h2>
<p class="note">Distinguishes one-off scripts (query_count = 1) from repeat/active agents (query_count > 1).</p>
<table><thead><tr><th>Payer wallet</th><th class="num">Queries</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>${freqRows || "<tr><td colspan=4>No data.</td></tr>"}</tbody></table>`;
}

/** JSON API for this same data — for scripted analysis rather than eyeballing the HTML. */
export function callerAnalyticsToJson(data: CallerAnalytics): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
