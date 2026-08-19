import type { Confidence, DataSufficiency, Env, PayerConcentration, PriceFairness, Recommendation, Tier } from "./types";
import { BASE_MAINNET_NETWORK } from "./refresh/indexer";
import { SOLANA_MAINNET_NETWORK } from "./refresh/solana-indexer";
import { CATEGORIES } from "./categorize/types";
import { MIN_TX_FOR_CONFIDENCE, median, scorePriceFairness } from "./scoring";
import { deriveConfidence, derivePayerConcentration, deriveRecommendation } from "./tool";
import { BRAND_CSS, FAVICON_LINK, FONT_LINKS, renderMonogram, renderWordmark } from "./brand";

interface RawDashboardRow {
  wallet_address: string;
  chain: string;
  tier: string;
  reasons_json: string | null;
  total_tx_count: number;
  unique_payer_count: number;
  wallet_age_days: number | null;
  refreshed_at: number;
  /** Null until src/categorize has run for this wallet at least once. */
  category: string | null;
  /** Raw JSON string — parse before use, same pattern as reasons_json. NULL until ingested at least once. */
  platforms_json: string | null;
}

/**
 * recommendation/confidence/payer_concentration are computed here from the
 * same stored tier/total_tx_count/unique_payer_count, reusing src/tool.ts's
 * own derive* functions rather than second copies of that logic — this is
 * display-time derivation, not new stored columns, so it can never drift
 * out of sync with what check_merchant itself returns for the same wallet.
 *
 * ownPricesAtomic/priceFairness are genuinely new here (2026-08-13):
 * price_observations has always held each wallet's own currently-advertised
 * price(s) per resource (see db/schema.sql), collected every refresh cycle,
 * but nothing ever surfaced it on the dashboard — this was flagged directly
 * ("what are the price differences — this is data we should have readily
 * available") and was a fair complaint, since it really was already sitting
 * in the store unused. priceFairness compares each wallet's own median
 * advertised price against its category peers' median, the same comparison
 * check_merchant does when a caller supplies `price` — computed here for
 * every wallet unconditionally, without needing a caller-supplied price.
 */
interface DashboardRow extends RawDashboardRow {
  recommendation: Recommendation;
  confidence: Confidence;
  payerConcentration: PayerConcentration;
  ownPricesAtomic: number[];
  priceFairness: PriceFairness;
}

export type RecommendationCounts = { proceed: number; caution: number; insufficientSignal: number };

interface DashboardData {
  rows: DashboardRow[];
  /** Combined across both chains — shown alongside, never instead of, the per-chain breakdown below. See requirement note at renderDashboardHtml. */
  counts: RecommendationCounts;
  /** Kept separate from `counts` deliberately — see README "Solana signal caveats": Solana's ~4x faster finality means signal 6 (velocity/harness-break) can't yet be assumed to behave the same as it does on Base, so a single pooled "proceed %" would blend two not-yet-cross-validated methodologies. Both breakdowns stay available even though signal 6 is currently a no-op (always 0) on both chains — the split doesn't cost anything and stays correct once signal 6 is real. */
  countsByChain: { base: RecommendationCounts; solana: RecommendationCounts };
  lastRefreshedAt: number | null;
}

export async function getDashboardData(env: Env): Promise<DashboardData> {
  // is_demo excludes the two synthetic rows; network restricts to the real
  // mainnet networks this app actually ingests (Base mainnet + Solana
  // mainnet) — excludes the demo rows' Base Sepolia network as a second,
  // independent guard against the same failure mode (fake/testnet data
  // reaching the public dashboard), not merely a duplicate of is_demo=0.
  const { results: rawResults } = await env.DB.prepare(
    `SELECT wallet_address, chain, tier, reasons_json, total_tx_count, unique_payer_count,
            wallet_age_days, refreshed_at, category, platforms_json
     FROM merchant_signals
     WHERE is_demo = 0 AND network IN (?, ?)
     ORDER BY total_tx_count DESC
     LIMIT 1000`,
  )
    .bind(BASE_MAINNET_NETWORK, SOLANA_MAINNET_NETWORK)
    .all<RawDashboardRow>();

  // Category-snapshot price rows only (payer_address IS NULL — see
  // db/schema.sql price_observations for the other kind of row this table
  // holds). One row per (wallet, resource) the wallet backs, so a wallet
  // with several resources has several rows here, potentially at different
  // prices — kept as a list per wallet rather than collapsed, so the UI can
  // show a real range instead of a single number that hides spread.
  // pricesByCategory keeps {wallet, price} pairs, not bare numbers, so each
  // wallet's own rows can be excluded from its own peer comparison below
  // (same reasoning as db/queries.ts getComparablePrices: comparing a
  // wallet against a peer set that includes itself understates how it
  // actually differs from real peers).
  const { results: priceRows } = await env.DB.prepare(
    `SELECT wallet_address, resource_type AS category, price_atomic
     FROM price_observations WHERE payer_address IS NULL`,
  ).all<{ wallet_address: string; category: string; price_atomic: number }>();

  const pricesByWallet = new Map<string, number[]>();
  const pricesByCategory = new Map<string, { wallet: string; price: number }[]>();
  for (const p of priceRows) {
    pricesByWallet.set(p.wallet_address, [...(pricesByWallet.get(p.wallet_address) ?? []), p.price_atomic]);
    pricesByCategory.set(p.category, [...(pricesByCategory.get(p.category) ?? []), { wallet: p.wallet_address, price: p.price_atomic }]);
  }

  const results: DashboardRow[] = rawResults.map((row) => {
    const dataSufficiency: DataSufficiency = row.total_tx_count < MIN_TX_FOR_CONFIDENCE ? "INSUFFICIENT" : "SUFFICIENT";
    // tier is only ever null in D1 for rows that predate scoring — treat as caution (the same fallback scoreMerchant's own tier column default would imply) rather than crashing the dashboard on a row this old.
    const tier = (row.tier === "trusted" || row.tier === "caution" || row.tier === "avoid" ? row.tier : "caution") as Tier;

    const ownPricesAtomic = pricesByWallet.get(row.wallet_address) ?? [];
    const ownMedian = median(ownPricesAtomic);
    // category can be NULL (uncategorized) — no meaningful peer set to
    // compare against in that case, priceFairness stays "unknown" rather
    // than comparing across unrelated categories.
    let priceFairness: PriceFairness = "unknown";
    if (ownMedian !== null && row.category) {
      const peers = (pricesByCategory.get(row.category) ?? [])
        .filter((p) => p.wallet !== row.wallet_address)
        .map((p) => p.price);
      priceFairness = scorePriceFairness(ownMedian, peers);
    }

    return {
      ...row,
      recommendation: deriveRecommendation(dataSufficiency, tier),
      confidence: deriveConfidence(row.total_tx_count),
      payerConcentration: derivePayerConcentration(row.unique_payer_count, row.total_tx_count),
      ownPricesAtomic,
      priceFairness,
    };
  });

  const counts: RecommendationCounts = { proceed: 0, caution: 0, insufficientSignal: 0 };
  const countsByChain = {
    base: { proceed: 0, caution: 0, insufficientSignal: 0 },
    solana: { proceed: 0, caution: 0, insufficientSignal: 0 },
  };
  let lastRefreshedAt: number | null = null;
  for (const row of results) {
    const key = row.recommendation === "PROCEED" ? "proceed" : row.recommendation === "CAUTION" ? "caution" : "insufficientSignal";
    counts[key]++;
    if (row.chain === "base" || row.chain === "solana") {
      countsByChain[row.chain][key]++;
    }
    if (lastRefreshedAt === null || row.refreshed_at > lastRefreshedAt) {
      lastRefreshedAt = row.refreshed_at;
    }
  }

  return { rows: results, counts, countsByChain, lastRefreshedAt };
}

/** JSON API — same data the HTML table renders, for anyone who wants raw access. */
export function dashboardDataToJson(data: DashboardData): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });
}

export interface DashboardSummary {
  counts: RecommendationCounts;
  countsByChain: { base: RecommendationCounts; solana: RecommendationCounts };
  total: number;
  lastRefreshedAt: number | null;
}

/**
 * Aggregate-only counterpart to getDashboardData (2026-08-19) — added back
 * to the public homepage after the data-access lockdown (see README "Data
 * access policy"), scoped deliberately narrow: total merchants indexed,
 * proceed/caution/insufficient-signal counts, and the same split by chain.
 * No wallet address, reasons, platforms, category, or pricing — the exact
 * fields that made the old dashboard/`/api/wallets` a free substitute for
 * the paid check_merchant tool.
 *
 * Not just "the same query with fewer fields rendered" — the SQL itself
 * only ever selects (chain, tier, total_tx_count), so no merchant-
 * identifying data is pulled into Worker memory in the first place, not
 * merely withheld at render time. Recommendation is still derived via
 * src/tool.ts's own deriveRecommendation/MIN_TX_FOR_CONFIDENCE rather than
 * reimplementing that threshold logic in SQL, so this can never drift out
 * of sync with what check_merchant or getDashboardData would compute for
 * the same row.
 */
export async function getDashboardSummary(env: Env): Promise<DashboardSummary> {
  const { results } = await env.DB.prepare(
    `SELECT chain, tier, total_tx_count, refreshed_at
     FROM merchant_signals
     WHERE is_demo = 0 AND network IN (?, ?)`,
  )
    .bind(BASE_MAINNET_NETWORK, SOLANA_MAINNET_NETWORK)
    .all<{ chain: string; tier: string | null; total_tx_count: number; refreshed_at: number }>();

  const counts: RecommendationCounts = { proceed: 0, caution: 0, insufficientSignal: 0 };
  const countsByChain = {
    base: { proceed: 0, caution: 0, insufficientSignal: 0 },
    solana: { proceed: 0, caution: 0, insufficientSignal: 0 },
  };
  let lastRefreshedAt: number | null = null;

  for (const row of results) {
    const dataSufficiency: DataSufficiency = row.total_tx_count < MIN_TX_FOR_CONFIDENCE ? "INSUFFICIENT" : "SUFFICIENT";
    const tier = (row.tier === "trusted" || row.tier === "caution" || row.tier === "avoid" ? row.tier : "caution") as Tier;
    const recommendation = deriveRecommendation(dataSufficiency, tier);
    const key = recommendation === "PROCEED" ? "proceed" : recommendation === "CAUTION" ? "caution" : "insufficientSignal";
    counts[key]++;
    if (row.chain === "base" || row.chain === "solana") {
      countsByChain[row.chain][key]++;
    }
    if (lastRefreshedAt === null || row.refreshed_at > lastRefreshedAt) {
      lastRefreshedAt = row.refreshed_at;
    }
  }

  return { counts, countsByChain, total: results.length, lastRefreshedAt };
}

/** Exported so src/callerDashboard.ts (internal admin dashboard) reuses the same escaping instead of a second copy. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Exported so src/merchantProfile.ts renders the same truncated form in its own header instead of a second copy. */
export function truncateAddress(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

/** Exported so src/merchantProfile.ts's "last refreshed" line matches the dashboard's own wording instead of a second copy. */
export function relativeTime(unixSeconds: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

interface PlatformEntry {
  url: string;
  serviceName: string | null;
}

/**
 * Renders the platforms_json cell. The platform name itself links to the
 * merchant's internal profile page (`profileHref`) per the 2026-08-18 ask
 * ("accessible by clicking on either their platform name or wallet") —
 * previously it linked straight out to the external resource URL, which is
 * still one click away via the small ↗ icon so that path isn't lost.
 * Falls back to "—" when nothing's been ingested yet (not an error state,
 * just unmeasured, same as other NULL-until-ingested fields).
 */
function renderPlatformsCell(platformsJson: string | null, profileHref: string): string {
  if (!platformsJson) return '<span class="pill pill-muted">—</span>';
  let platforms: PlatformEntry[];
  try {
    const parsed = JSON.parse(platformsJson);
    platforms = Array.isArray(parsed) ? parsed : [];
  } catch {
    return '<span class="pill pill-muted">—</span>';
  }
  if (platforms.length === 0) return '<span class="pill pill-muted">—</span>';

  const links = platforms.map((p) => {
    let hostname = p.url;
    try {
      hostname = new URL(p.url).hostname;
    } catch {
      // Not a parseable absolute URL — show the raw string as-is rather than failing.
    }
    const label = escapeHtml(p.serviceName || hostname);
    return (
      `<a href="${profileHref}" title="View merchant profile">${label}</a>` +
      `<a class="ext-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="Open ${escapeHtml(p.url)}">↗</a>`
    );
  });
  const shown = links.slice(0, 1).join("");
  const extra = links.length > 1 ? ` <span class="pill pill-muted">+${links.length - 1} more</span>` : "";
  return shown + extra;
}

/** 'proceed' | 'caution' | 'insufficient' — used for both the CSS class suffix and the data-recommendation filter attribute. Exported so src/merchantProfile.ts's badge matches the dashboard's exactly. */
export function recommendationSlug(rec: Recommendation): string {
  if (rec === "PROCEED") return "proceed";
  if (rec === "CAUTION") return "caution";
  return "insufficient";
}

export function recommendationLabel(rec: Recommendation): string {
  if (rec === "PROCEED") return "Proceed";
  if (rec === "CAUTION") return "Caution";
  return "Insufficient signal";
}

/** Own advertised price(s) — a range if the wallet backs multiple resources at different prices — plus a fairness pill against category peers, when computable. Both were already collected every refresh cycle and simply never surfaced before 2026-08-13. Exported so src/merchantProfile.ts's price section renders identically instead of a second copy. */
export function renderPriceCell(pricesAtomic: number[], fairness: PriceFairness): string {
  if (pricesAtomic.length === 0) return '<span class="pill pill-muted">—</span>';
  const usd = pricesAtomic.map((p) => p / 1_000_000);
  const min = Math.min(...usd);
  const max = Math.max(...usd);
  const fmt = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
  const priceLabel = min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
  const fairnessPill = fairness === "unknown" ? "" : ` <span class="pill pill-fairness-${fairness}">${escapeHtml(fairness)}</span>`;
  return `${escapeHtml(priceLabel)}${fairnessPill}`;
}

/** Small inline label appended to the payer count — surfaces payer_concentration without a whole extra column. Exported so src/merchantProfile.ts reuses it. */
export function payerConcentrationLabel(concentration: PayerConcentration): string {
  if (concentration === "UNKNOWN") return "";
  return ` <span class="pill-muted small">${escapeHtml(concentration.toLowerCase())} conc.</span>`;
}

export function renderDashboardHtml(data: DashboardData): string {
  const { rows, counts, countsByChain, lastRefreshedAt } = data;
  const total = counts.proceed + counts.caution + counts.insufficientSignal;
  const pct = (n: number, denom: number) => (denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0);
  const chainTotal = (c: RecommendationCounts) => c.proceed + c.caution + c.insufficientSignal;
  const baseTotal = chainTotal(countsByChain.base);
  const solanaTotal = chainTotal(countsByChain.solana);

  const rowsHtml = rows
    .map((r) => {
      const reasons: string[] = r.reasons_json ? JSON.parse(r.reasons_json) : [];
      const category = r.category ?? "uncategorized";
      const chain = r.chain === "solana" ? "solana" : "base";
      const recSlug = recommendationSlug(r.recommendation);
      // title carries the richer trust_tier detail (TRUSTED/CAUTION/AVOID) on
      // hover — recommendation is the primary, product-facing label per the
      // pre-payment-primitive rework (see INTEGRATION.md); trust_tier is
      // supplementary, not hidden, just not the headline.
      const profileHref = `/merchant/${encodeURIComponent(r.wallet_address)}`;
      return `<tr data-recommendation="${recSlug}" data-category="${category}" data-chain="${chain}" data-address="${escapeHtml(r.wallet_address)}">
        <td><a class="addr-link" href="${profileHref}" title="View merchant profile"><code class="addr">${truncateAddress(r.wallet_address)}</code></a></td>
        <td><span class="pill pill-chain">${chain}</span></td>
        <td>
          <span class="badge badge-${recSlug}" title="trust_tier: ${escapeHtml(r.tier.toUpperCase())}">${recommendationLabel(r.recommendation)}</span>
          <span class="pill-muted small">${escapeHtml(r.confidence.toLowerCase())} confidence</span>
        </td>
        <td>${renderPlatformsCell(r.platforms_json, profileHref)}</td>
        <td><span class="pill">${escapeHtml(category.replace(/_/g, " "))}</span></td>
        <td>${renderPriceCell(r.ownPricesAtomic, r.priceFairness)}</td>
        <td class="num">${r.total_tx_count.toLocaleString()}</td>
        <td class="num">${r.unique_payer_count.toLocaleString()}${payerConcentrationLabel(r.payerConcentration)}</td>
        <td class="reasons">${reasons.map((x) => `<span class="reason">${escapeHtml(x)}</span>`).join("")}</td>
      </tr>`;
    })
    .join("\n");

  const categoryOptions = ["all", ...CATEGORIES, "uncategorized"]
    .map((c) => `<option value="${c}">${c === "all" ? "All categories" : c.replace(/_/g, " ")}</option>`)
    .join("");

  return `<title>x402 Merchant Check | Gradient Decisions</title>
<meta name="description" content="Pre-payment merchant intelligence for x402 agents: live recommendations for Base and Solana merchants, scored from observable on-chain payment behavior.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FONT_LINKS}
<style>
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280;
    --proceed: #16a34a; --proceed-bg: #dcfce7; --caution: #b45309; --caution-bg: #fef3c7;
    --insufficient: #6b7280; --insufficient-bg: #f1f1f3; --accent: #4f46e5;
    /* Monochrome fade, not an invented color gradient — this is the same
       horizontal-opacity-fade treatment the actual logo uses (see
       src/brand.ts), just applied to a UI accent instead of letterforms.
       Deliberately not a hue gradient (indigo->violet->magenta was here
       originally): that's a decorative color scheme with no basis in the
       real brand assets, and this is a trust-first commerce product, not
       an agency/playful brand — restraint over decoration. */
    --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0d; --surface: #17171a; --border: #2a2a2e; --text: #f4f4f5; --text-dim: #9ca3af;
      --proceed: #4ade80; --proceed-bg: #14532d; --caution: #fbbf24; --caution-bg: #78350f;
      --insufficient: #9ca3af; --insufficient-bg: #27272a; --accent: #818cf8;
      --brand-gradient: linear-gradient(90deg, var(--accent) 0%, transparent 100%);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    line-height: 1.5;
  }
  ${BRAND_CSS}
  .wrap { max-width: 1080px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  .topbar { position: relative; height: 3px; background: var(--brand-gradient); margin: -2.5rem -1.5rem 2rem; }
  .brand-row { display: flex; align-items: center; gap: .55rem; margin-bottom: .6rem; }
  .brand-row .brand-mark { width: 34px; }
  header h1 { font-size: 1.55rem; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  header p.tagline { color: var(--text-dim); margin: 0 0 1.75rem; max-width: 60ch; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 1.75rem; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem 1.1rem; box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  .stat-card .n { font-size: 1.6rem; font-weight: 650; }
  .stat-card .label { font-size: .8rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .03em; }
  .stat-card.proceed .n { color: var(--proceed); }
  .stat-card.caution .n { color: var(--caution); }
  .stat-card.insufficient .n { color: var(--insufficient); }
  .bars { display: flex; height: 10px; border-radius: 6px; overflow: hidden; margin-bottom: 2rem; border: 1px solid var(--border); }
  .bar-proceed { background: var(--proceed); }
  .bar-caution { background: var(--caution); }
  .bar-insufficient { background: var(--insufficient); }
  .controls { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: center; }
  .controls input[type=search] {
    flex: 1; min-width: 200px; padding: .55rem .8rem; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-size: .9rem;
  }
  .filter-btn {
    padding: .45rem .85rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text-dim); font-size: .82rem; cursor: pointer;
  }
  .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }
  th, td { text-align: left; padding: .6rem .85rem; border-bottom: 1px solid var(--border); font-size: .87rem; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-dim); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code.addr { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .82rem; }
  .badge { display: inline-block; padding: .15rem .55rem; border-radius: 999px; font-size: .76rem; font-weight: 600; text-transform: capitalize; }
  .badge-proceed { background: var(--proceed-bg); color: var(--proceed); }
  .badge-caution { background: var(--caution-bg); color: var(--caution); }
  .badge-insufficient { background: var(--insufficient-bg); color: var(--insufficient); }
  .reasons { max-width: 320px; }
  .pill {
    display: inline-block; padding: .1rem .5rem; border-radius: 6px; font-size: .76rem;
    text-transform: capitalize; background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
  }
  .pill-chain { text-transform: uppercase; letter-spacing: .02em; font-weight: 600; }
  .pill-muted { text-transform: none; }
  .pill-muted.small, span.small { font-size: .72rem; color: var(--text-dim); background: none; border: none; padding: 0; display: inline-block; }
  .pill-fairness-fair { color: var(--proceed); border-color: var(--proceed); }
  .pill-fairness-high { color: var(--caution); border-color: var(--caution); }
  .pill-fairness-low { color: var(--accent); border-color: var(--accent); }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  a.addr-link code.addr { color: var(--accent); }
  a.addr-link:hover code.addr { text-decoration: underline; }
  a.ext-link { margin-left: .3rem; font-size: .78rem; opacity: .6; }
  a.ext-link:hover { opacity: 1; }
  select#category-filter, select#chain-filter {
    padding: .45rem .7rem; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-size: .82rem;
  }
  .chain-breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
  .chain-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: .85rem 1rem; }
  .chain-card .chain-title { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin-bottom: .4rem; }
  .chain-card .chain-stats { display: flex; gap: 1rem; font-size: .85rem; }
  .chain-card .chain-stats b { font-variant-numeric: tabular-nums; }
  .chain-note { font-size: .8rem; color: var(--text-dim); margin: -.5rem 0 1.5rem; max-width: 70ch; }
  .reason {
    display: inline-block; font-size: .74rem; color: var(--text-dim); background: var(--bg);
    border: 1px solid var(--border); border-radius: 6px; padding: .1rem .4rem; margin: .1rem .2rem .1rem 0;
  }
  footer { margin-top: 2.5rem; color: var(--text-dim); font-size: .82rem; }
  .footer-brand { opacity: .55; margin-bottom: .85rem; }
  footer a { color: var(--accent); }
  .empty { text-align: center; color: var(--text-dim); padding: 2rem; }
  .overflow { overflow-x: auto; }
  code.small { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: .1rem .35rem; font-size: .82rem; }
</style>
<div class="topbar"></div>
<div class="wrap">
  <header>
    <div class="brand-row">
      ${renderMonogram("dash-header", 34)}
      <h1>x402 Merchant Check</h1>
    </div>
    <p class="tagline">
      Context for agentic buying decisions: merchant trust tiers for autonomous agent
      commerce, scored from real on-chain and x402 activity. This is not a certification,
      just an algorithmic read of public signals. Same data agents get via the
      <code class="small">check_merchant</code> MCP tool at
      <code class="small">mcp.gradientdecisions.com</code> ($0.01/query via x402), free to
      browse here. Covers both Base and Solana x402 activity.
    </p>
  </header>

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
        <span class="proceed"><b>${pct(countsByChain.base.proceed, baseTotal)}%</b> proceed</span>
      </div>
    </div>
    <div class="chain-card">
      <div class="chain-title">Solana</div>
      <div class="chain-stats">
        <span>${solanaTotal.toLocaleString()} merchants</span>
        <span class="proceed"><b>${pct(countsByChain.solana.proceed, solanaTotal)}%</b> proceed</span>
      </div>
    </div>
  </div>
  <p class="chain-note">
    Shown separately from the combined figures above on purpose: Solana settles roughly 4x
    faster than Base, and the velocity/anomaly signal hasn't yet been validated as behaving
    the same way across both. See the <code class="small">chain</code> filter below to
    inspect either network on its own.
  </p>

  <div class="controls">
    <input type="search" id="search" placeholder="Search wallet address…" autocomplete="off">
    <button class="filter-btn active" data-recommendation="all">All</button>
    <button class="filter-btn" data-recommendation="proceed">Proceed</button>
    <button class="filter-btn" data-recommendation="caution">Caution</button>
    <button class="filter-btn" data-recommendation="insufficient">Insufficient signal</button>
    <select id="chain-filter">
      <option value="all">All chains</option>
      <option value="base">Base</option>
      <option value="solana">Solana</option>
    </select>
    <select id="category-filter">${categoryOptions}</select>
  </div>

  <div class="overflow">
    <table id="tbl">
      <thead><tr><th>Wallet</th><th>Chain</th><th>Recommendation</th><th>Platform</th><th>Category</th><th>Price</th><th class="num">Calls (30d)</th><th class="num">Unique payers</th><th>Reasons</th></tr></thead>
      <tbody>${rowsHtml || ""}</tbody>
    </table>
    <p class="empty" id="empty" style="display:none">No wallets match.</p>
  </div>

  <footer>
    <div class="footer-brand">${renderWordmark("dash-footer", 130)}</div>
    Data sources: <a href="https://docs.cdp.coinbase.com/x402/bazaar" target="_blank" rel="noopener">x402 Bazaar</a>
    (Base mainnet) and <a href="https://facilitator.payai.network" target="_blank" rel="noopener">PayAI Network</a>
    discovery + Helius RPC (Solana mainnet). Refreshed periodically,
    last update ${lastRefreshedAt ? relativeTime(lastRefreshedAt) : "never"}.
    Raw data: <a href="/api/wallets">/api/wallets</a>. <a href="/privacy">Privacy policy</a>.
  </footer>
</div>
<script>
  const search = document.getElementById('search');
  const buttons = document.querySelectorAll('.filter-btn');
  const categoryFilter = document.getElementById('category-filter');
  const chainFilter = document.getElementById('chain-filter');
  const rows = [...document.querySelectorAll('#tbl tbody tr')];
  const empty = document.getElementById('empty');
  let activeRecommendation = 'all';

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    const activeCategory = categoryFilter.value;
    const activeChain = chainFilter.value;
    let visible = 0;
    for (const row of rows) {
      const recOk = activeRecommendation === 'all' || row.dataset.recommendation === activeRecommendation;
      const categoryOk = activeCategory === 'all' || row.dataset.category === activeCategory;
      const chainOk = activeChain === 'all' || row.dataset.chain === activeChain;
      // Search is a plain case-insensitive substring match for UX
      // convenience only — it never writes back a lowercased value anywhere,
      // so it doesn't risk corrupting case-sensitive Solana addresses the
      // way a stored/queried lowercase would (see src/chains.ts).
      const searchOk = !q || row.dataset.address.toLowerCase().includes(q);
      const show = recOk && categoryOk && chainOk && searchOk;
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    empty.style.display = visible === 0 ? '' : 'none';
  }

  search.addEventListener('input', applyFilter);
  categoryFilter.addEventListener('change', applyFilter);
  chainFilter.addEventListener('change', applyFilter);
  buttons.forEach((btn) => btn.addEventListener('click', () => {
    buttons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeRecommendation = btn.dataset.recommendation;
    applyFilter();
  }));
</script>`;
}
