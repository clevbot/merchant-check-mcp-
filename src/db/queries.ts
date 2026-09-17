import type { Env, MerchantSignalRow } from "../types";
import { detectAndNormalize } from "../chains";

/**
 * Basic shape check — full validation happens on-chain, this just guards
 * D1/input. Re-exported from src/chains.ts (single source of truth for both
 * Base and Solana address formats) rather than redefined here.
 */
export { isValidWalletAddress } from "../chains";

export async function getMerchantSignals(
  env: Env,
  walletAddress: string,
): Promise<MerchantSignalRow | null> {
  // Base addresses are lowercased for lookup; Solana addresses are
  // case-sensitive base58 and must be left exactly as given — see
  // src/chains.ts. Caller (src/tool.ts) already validated the address, so
  // detectAndNormalize is expected to succeed here.
  const detected = detectAndNormalize(walletAddress);
  const normalized = detected ? detected.normalized : walletAddress;
  const row = await env.DB.prepare(
    "SELECT * FROM merchant_signals WHERE wallet_address = ?",
  )
    .bind(normalized)
    .first<MerchantSignalRow>();
  return row ?? null;
}

/**
 * Comparable prices for price-fairness (src/tool.ts). `category` is the
 * merchant's own src/categorize category, not a caller-supplied string —
 * price_observations.resource_type holds category values written by
 * src/refresh/index.ts upsertCategoryPriceObservations (payer_address IS
 * NULL rows specifically; see db/schema.sql for the other kind of row this
 * table can hold). Implemented 2026-08-11 once category gave this function
 * an actual bucket to compare within — previously always returned "unknown"
 * since nothing populated price_observations at all.
 *
 * ORDER BY RANDOM() rather than ORDER BY observed_at DESC: every row from a
 * given bulk refresh shares the exact same observed_at (they're all written
 * in one pass — see upsertCategoryPriceObservations), so sorting by it isn't
 * sorting by anything at all with a fully-tied key, and LIMIT then returns
 * some arbitrary but *not* representative subset of rows. Caught this live:
 * a real merchant priced far below its category's true median still came
 * back price_fairness "high", because the LIMIT 200 subset it happened to
 * compare against was itself skewed low. A random sample is representative
 * regardless of how many rows share a timestamp, and stays correct even
 * once refresh timing gives observed_at genuine spread in the future.
 *
 * Deliberately NOT filtered by chain: this compares atomic USDC units, and
 * Base USDC and Solana (SPL) USDC both use 6 decimals (cross-checked against
 * two independent sources — see src/refresh/solana-indexer.ts), so an atomic
 * value from one chain is directly comparable to the other within the same
 * category. If a future asset with different decimals enters this table,
 * comparisons must be normalized to a common unit before reaching this
 * function, not filtered out silently.
 */
export async function getComparablePrices(
  env: Env,
  category: string,
  excludeWallet: string,
): Promise<number[]> {
  const detected = detectAndNormalize(excludeWallet);
  const normalizedExclude = detected ? detected.normalized : excludeWallet;
  const { results } = await env.DB.prepare(
    `SELECT price_atomic FROM price_observations
     WHERE resource_type = ? AND wallet_address != ? AND payer_address IS NULL
     ORDER BY RANDOM() LIMIT 200`,
  )
    .bind(category, normalizedExclude)
    .all<{ price_atomic: number }>();
  return results.map((r) => r.price_atomic);
}

/**
 * A merchant's own currently-advertised price(s) — one per resource it
 * backs, atomic USDC units. Added 2026-08-13: this data has always been
 * collected every refresh cycle (see upsertCategoryPriceObservations) but
 * check_merchant never read it back — price_fairness only ever compared a
 * *caller-supplied* price, so an agent that didn't already have a quote in
 * hand got no pricing context at all. Distinct from getComparablePrices,
 * which excludes this wallet to build a peer set; this is the wallet's own
 * rows specifically.
 */
export async function getOwnPrices(env: Env, walletAddress: string): Promise<number[]> {
  const detected = detectAndNormalize(walletAddress);
  const normalized = detected ? detected.normalized : walletAddress;
  const { results } = await env.DB.prepare(
    `SELECT price_atomic FROM price_observations WHERE wallet_address = ? AND payer_address IS NULL`,
  )
    .bind(normalized)
    .all<{ price_atomic: number }>();
  return results.map((r) => r.price_atomic);
}

export interface LogQueryParams {
  queriedWallet: string;
  payerAddress: string | null;
  txHash: string | null;
  tierReturned: string;
  /** 'PROCEED' | 'CAUTION' | 'INSUFFICIENT_SIGNAL' — the real recommendation, captured via closure in src/index.ts createServer (see db/schema.sql query_log.recommendation comment for why this wasn't possible before 2026-08-12). */
  recommendation: string | null;
  /** Wall-clock ms from request start to settlement. */
  latencyMs: number | null;
  /** The checked merchant's own category from the response — see db/schema.sql query_log.queried_category comment for why this isn't caller-supplied. */
  queriedCategory: string | null;
  /** Genuinely caller-supplied: input.price converted to atomic units, NULL if the caller didn't pass one. Added for the internal caller-tracking dashboard (src/callerDashboard.ts) — see requirement in that feature's brief. */
  callerSuppliedPriceAtomic: number | null;
}

/** Params object rather than positional args — this grew past the point positional args stay readable (added two more fields 2026-08-13 for the internal caller-tracking dashboard). */
export async function logQuery(env: Env, params: LogQueryParams): Promise<void> {
  // queriedWallet can now be a Solana merchant address — must not be
  // unconditionally lowercased (see src/chains.ts). payerAddress is left
  // as-is: it's the address that paid *our* x402 endpoint, which only
  // accepts Base payments today, so it's always EVM and case-insensitive.
  const detected = detectAndNormalize(params.queriedWallet);
  const normalizedQueried = detected ? detected.normalized : params.queriedWallet;
  await env.DB.prepare(
    `INSERT INTO query_log (
      queried_wallet_address, payer_address, tx_hash, tier_returned, recommendation, latency_ms,
      queried_category, caller_supplied_price_atomic, queried_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      normalizedQueried,
      params.payerAddress,
      params.txHash,
      params.tierReturned,
      params.recommendation,
      params.latencyMs,
      params.queriedCategory,
      params.callerSuppliedPriceAtomic,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export interface LogRequestEventParams {
  path: "/mcp" | "/check";
  eventType: "challenge_issued" | "verify_failed" | "protocol_call";
  /** Set for 'challenge_issued'/'verify_failed' — NULL for 'protocol_call' (see mcpMethod instead). */
  toolName: string | null;
  /** The raw JSON-RPC method ('initialize', 'tools/list', 'ping', ...) — set only for 'protocol_call'. */
  mcpMethod: string | null;
  queriedWalletAddress: string | null;
  /** Only meaningful for eventType 'verify_failed'. */
  verifyError: string | null;
  callerIp: string | null;
  userAgent: string | null;
  asn: number | null;
  asOrganization: string | null;
  country: string | null;
  colo: string | null;
}

/**
 * Writes the top/middle of the funnel query_log's own comment (see
 * getMetricsSummary below) flagged as a real, unaddressed gap: "it cannot
 * see how many 402 challenges were issued that never converted to a call
 * here... measuring that needs instrumentation earlier in the x402
 * handshake." This is that instrumentation — see db/schema.sql
 * request_events for the full reasoning on why 'settled' is deliberately
 * not a value logged here (query_log stays the sole source of truth for
 * that fact).
 *
 * Called from src/index.ts's onPaymentRequired/onVerifyFailure hooks via
 * ctx.waitUntil — fire-and-forget, must never add latency or a failure
 * mode to the actual payment path it's observing.
 */
export async function logRequestEvent(env: Env, params: LogRequestEventParams): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO request_events (
      occurred_at, path, event_type, tool_name, mcp_method, queried_wallet_address, verify_error,
      caller_ip, user_agent, asn, as_organization, country, colo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      Math.floor(Date.now() / 1000),
      params.path,
      params.eventType,
      params.toolName,
      params.mcpMethod,
      params.queriedWalletAddress,
      params.verifyError,
      params.callerIp,
      params.userAgent,
      params.asn,
      params.asOrganization,
      params.country,
      params.colo,
    )
    .run();
}

export interface FunnelCounts {
  challengeIssued: number;
  verifyFailed: number;
  settled: number;
}

export interface TopCount {
  value: string;
  count: number;
}

export interface DailyFunnel {
  day: string; // YYYY-MM-DD
  challengeIssued: number;
  verifyFailed: number;
  settled: number;
}

export interface RequestAnalytics {
  windowSeconds: number;
  funnel: FunnelCounts;
  /**
   * Separate from `funnel` on purpose: this counts MCP-level protocol
   * traffic (initialize, tools/list, ping, ...) that never even attempts
   * to call check_merchant — added after live traffic inspection showed
   * this is most of what /mcp actually sees (directories/crawlers
   * checking the server exists and is protocol-compliant), which the
   * original challenge/verify/settled funnel had no way to represent.
   * Mixing it into `funnel` would make "total attempts" mean two
   * different things depending on which number moved.
   */
  protocolCallCount: number;
  topMcpMethods: TopCount[];
  topUserAgents: TopCount[];
  topAsOrganizations: TopCount[];
  topCountries: TopCount[];
  /** What callers are actually asking about — top queried_wallet_address values across both event types. */
  topRequestedWallets: TopCount[];
  dailyFunnel: DailyFunnel[];
  /** Most recent raw events, newest first — for eyeballing real traffic, not just aggregates. */
  recentEvents: (LogRequestEventParams & { occurredAt: number })[];
}

/**
 * Reads request_events + query_log together to build the full funnel —
 * see src/requestAnalytics.ts for the admin page this backs. 'settled'
 * comes from query_log (see logRequestEvent's own comment for why it's
 * not duplicated into request_events); everything else comes from
 * request_events. Capped/windowed reads throughout — this is a debugging
 * view, not a paginated report, same posture as getCallerAnalytics.
 */
export async function getRequestAnalytics(env: Env, windowSeconds: number): Promise<RequestAnalytics> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;

  const queries = {
    challenge: env.DB.prepare(`SELECT COUNT(*) as n FROM request_events WHERE event_type = 'challenge_issued' AND occurred_at >= ?`)
      .bind(since)
      .first<{ n: number }>(),
    verifyFailed: env.DB.prepare(`SELECT COUNT(*) as n FROM request_events WHERE event_type = 'verify_failed' AND occurred_at >= ?`)
      .bind(since)
      .first<{ n: number }>(),
    protocolCall: env.DB.prepare(`SELECT COUNT(*) as n FROM request_events WHERE event_type = 'protocol_call' AND occurred_at >= ?`)
      .bind(since)
      .first<{ n: number }>(),
    settled: env.DB.prepare(`SELECT COUNT(*) as n FROM query_log WHERE queried_at >= ?`).bind(since).first<{ n: number }>(),
    mcpMethods: env.DB.prepare(
      `SELECT mcp_method as value, COUNT(*) as count FROM request_events
       WHERE occurred_at >= ? AND mcp_method IS NOT NULL
       GROUP BY mcp_method ORDER BY count DESC LIMIT 15`,
    )
      .bind(since)
      .all<TopCount>(),
    userAgents: env.DB.prepare(
      `SELECT user_agent as value, COUNT(*) as count FROM request_events
       WHERE occurred_at >= ? AND user_agent IS NOT NULL
       GROUP BY user_agent ORDER BY count DESC LIMIT 15`,
    )
      .bind(since)
      .all<TopCount>(),
    asOrganizations: env.DB.prepare(
      `SELECT as_organization as value, COUNT(*) as count FROM request_events
       WHERE occurred_at >= ? AND as_organization IS NOT NULL
       GROUP BY as_organization ORDER BY count DESC LIMIT 15`,
    )
      .bind(since)
      .all<TopCount>(),
    countries: env.DB.prepare(
      `SELECT country as value, COUNT(*) as count FROM request_events
       WHERE occurred_at >= ? AND country IS NOT NULL
       GROUP BY country ORDER BY count DESC LIMIT 15`,
    )
      .bind(since)
      .all<TopCount>(),
    wallets: env.DB.prepare(
      `SELECT queried_wallet_address as value, COUNT(*) as count FROM request_events
       WHERE occurred_at >= ? AND queried_wallet_address IS NOT NULL
       GROUP BY queried_wallet_address ORDER BY count DESC LIMIT 15`,
    )
      .bind(since)
      .all<TopCount>(),
    requestEventDaily: env.DB.prepare(
      `SELECT
         date(occurred_at, 'unixepoch') as day,
         SUM(CASE WHEN event_type = 'challenge_issued' THEN 1 ELSE 0 END) as challengeIssued,
         SUM(CASE WHEN event_type = 'verify_failed' THEN 1 ELSE 0 END) as verifyFailed
       FROM request_events WHERE occurred_at >= ? GROUP BY day ORDER BY day ASC`,
    )
      .bind(since)
      .all<{ day: string; challengeIssued: number; verifyFailed: number }>(),
    settledDaily: env.DB.prepare(
      `SELECT date(queried_at, 'unixepoch') as day, COUNT(*) as settled
       FROM query_log WHERE queried_at >= ? GROUP BY day ORDER BY day ASC`,
    )
      .bind(since)
      .all<{ day: string; settled: number }>(),
    recent: env.DB.prepare(
      `SELECT occurred_at, path, event_type, tool_name, mcp_method, queried_wallet_address, verify_error,
              caller_ip, user_agent, asn, as_organization, country, colo
       FROM request_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT 200`,
    )
      .bind(since)
      .all<Record<string, unknown>>(),
  };

  const [
    challengeRow,
    verifyFailedRow,
    protocolCallRow,
    settledRow,
    mcpMethodRows,
    uaRows,
    asOrgRows,
    countryRows,
    walletRows,
    requestEventDailyRows,
    settledDailyRows,
    recentRows,
  ] = await Promise.all([
    queries.challenge,
    queries.verifyFailed,
    queries.protocolCall,
    queries.settled,
    queries.mcpMethods,
    queries.userAgents,
    queries.asOrganizations,
    queries.countries,
    queries.wallets,
    queries.requestEventDaily,
    queries.settledDaily,
    queries.recent,
  ]);

  const settledByDay = new Map((settledDailyRows.results ?? []).map((r) => [r.day, r.settled]));

  return {
    windowSeconds,
    funnel: {
      challengeIssued: challengeRow?.n ?? 0,
      verifyFailed: verifyFailedRow?.n ?? 0,
      settled: settledRow?.n ?? 0,
    },
    protocolCallCount: protocolCallRow?.n ?? 0,
    topMcpMethods: mcpMethodRows.results ?? [],
    topUserAgents: uaRows.results ?? [],
    topAsOrganizations: asOrgRows.results ?? [],
    topCountries: countryRows.results ?? [],
    topRequestedWallets: walletRows.results ?? [],
    dailyFunnel: mergeDailyFunnel(requestEventDailyRows.results ?? [], settledByDay),
    recentEvents: (recentRows.results ?? []).map((r) => ({
      occurredAt: r.occurred_at as number,
      path: r.path as "/mcp" | "/check",
      eventType: r.event_type as "challenge_issued" | "verify_failed" | "protocol_call",
      toolName: (r.tool_name as string) ?? null,
      mcpMethod: (r.mcp_method as string) ?? null,
      queriedWalletAddress: (r.queried_wallet_address as string) ?? null,
      verifyError: (r.verify_error as string) ?? null,
      callerIp: (r.caller_ip as string) ?? null,
      userAgent: (r.user_agent as string) ?? null,
      asn: (r.asn as number) ?? null,
      asOrganization: (r.as_organization as string) ?? null,
      country: (r.country as string) ?? null,
      colo: (r.colo as string) ?? null,
    })),
  };
}

function mergeDailyFunnel(
  requestEventDays: { day: string; challengeIssued: number; verifyFailed: number }[],
  settledByDay: Map<string, number>,
): DailyFunnel[] {
  const days = new Map<string, DailyFunnel>();
  for (const row of requestEventDays) {
    days.set(row.day, { day: row.day, challengeIssued: row.challengeIssued, verifyFailed: row.verifyFailed, settled: 0 });
  }
  for (const [day, settled] of settledByDay) {
    const existing = days.get(day);
    if (existing) {
      existing.settled = settled;
    } else {
      days.set(day, { day, challengeIssued: 0, verifyFailed: 0, settled });
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface MetricsSummary {
  windowSeconds: number;
  totalChecks: number;
  byRecommendation: { proceed: number; caution: number; insufficientSignal: number; unknown: number };
  distinctMerchantsChecked: number;
  /** Fraction of checks that were NOT the first check of that merchant within the window — an honest proxy for "would a response cache have helped", since this pipeline has no literal response cache to report hits/misses for (see README "Observability" for why). */
  repeatCheckRate: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

/**
 * Aggregates query_log for the brief's observability ask (section 11) —
 * computed on read, not maintained incrementally, since this is admin/
 * reporting traffic (see src/index.ts GET /metrics), not the hot paid
 * request path. Real gap, stated plainly rather than glossed over: this can
 * only measure checks that reached *this* tool and settled payment for it —
 * it cannot see how many 402 challenges were issued that never converted to
 * a call here, or how many agent payment flows skipped calling this tool
 * entirely. Measuring that needs instrumentation earlier in the x402
 * handshake than this table currently has, which is real future work, not
 * implemented here (see brief section 11's own "if the surrounding payment
 * system provides the necessary signals" caveat).
 */
export async function getMetricsSummary(env: Env, windowSeconds: number): Promise<MetricsSummary> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;

  const { results: recRows } = await env.DB.prepare(
    `SELECT recommendation, COUNT(*) as n FROM query_log WHERE queried_at >= ? GROUP BY recommendation`,
  )
    .bind(since)
    .all<{ recommendation: string | null; n: number }>();

  const byRecommendation = { proceed: 0, caution: 0, insufficientSignal: 0, unknown: 0 };
  let totalChecks = 0;
  for (const r of recRows) {
    totalChecks += r.n;
    if (r.recommendation === "PROCEED") byRecommendation.proceed += r.n;
    else if (r.recommendation === "CAUTION") byRecommendation.caution += r.n;
    else if (r.recommendation === "INSUFFICIENT_SIGNAL") byRecommendation.insufficientSignal += r.n;
    else byRecommendation.unknown += r.n; // NULL — rows logged before 2026-08-12, or a future recommendation value this summary doesn't know about yet
  }

  const { results: distinctRows } = await env.DB.prepare(
    `SELECT COUNT(DISTINCT queried_wallet_address) as n FROM query_log WHERE queried_at >= ?`,
  )
    .bind(since)
    .all<{ n: number }>();
  const distinctMerchantsChecked = distinctRows[0]?.n ?? 0;
  const repeatCheckRate = totalChecks > 0 ? (totalChecks - distinctMerchantsChecked) / totalChecks : 0;

  const { results: latencyRows } = await env.DB.prepare(
    `SELECT latency_ms FROM query_log WHERE queried_at >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC`,
  )
    .bind(since)
    .all<{ latency_ms: number }>();
  const latencies = latencyRows.map((r) => r.latency_ms);
  const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const p95LatencyMs = latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]! : null;

  return {
    windowSeconds,
    totalChecks,
    byRecommendation,
    distinctMerchantsChecked,
    repeatCheckRate,
    avgLatencyMs,
    p95LatencyMs,
  };
}
