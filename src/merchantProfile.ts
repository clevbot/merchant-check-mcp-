/**
 * Per-merchant profile page (added 2026-08-18) — a dedicated page for one
 * wallet, reachable by clicking either the wallet address or the platform
 * name on the public dashboard table (src/dashboard.ts). Reuses the exact
 * same derive-functions/scoring functions as the dashboard and check_merchant itself
 * (src/tool.ts, src/scoring.ts) rather than a third copy, so this page can
 * never show a recommendation/confidence/price-fairness read that disagrees
 * with what an agent actually gets from the paid tool for the same wallet.
 *
 * Deliberately reuses db/queries.ts's existing getMerchantSignals/
 * getComparablePrices/getOwnPrices rather than new raw SQL — those already
 * do exactly the lookups this page needs.
 */
import type { Confidence, DataSufficiency, Env, MerchantPlatform, PayerConcentration, PriceFairness, Recommendation, Tier } from "./types";
import { detectAndNormalize } from "./chains";
import { getComparablePrices, getMerchantSignals, getOwnPrices } from "./db/queries";
import { MIN_TX_FOR_CONFIDENCE, median, scorePriceFairness } from "./scoring";
import { deriveConfidence, derivePayerConcentration, deriveRecommendation, parsePlatforms, toTrustTier } from "./tool";
import { BRAND_CSS, FAVICON_LINK, FONT_LINKS, renderMonogram, renderWordmark } from "./brand";
import {
  escapeHtml,
  payerConcentrationLabel,
  recommendationLabel,
  recommendationSlug,
  relativeTime,
  renderPriceCell,
  truncateAddress,
} from "./dashboard";

export interface MerchantProfileData {
  walletAddress: string;
  chain: string;
  network: string;
  tier: Tier;
  reasons: string[];
  totalTxCount: number;
  uniquePayerCount: number;
  walletAgeDays: number | null;
  refreshedAt: number;
  category: string | null;
  bazaarDescription: string | null;
  platforms: MerchantPlatform[];
  completedFlowCount: number;
  abandonedFlowCount: number;
  refundCount: number;
  refundEligibleVolume: number;
  recommendation: Recommendation;
  confidence: Confidence;
  dataSufficiency: DataSufficiency;
  payerConcentration: PayerConcentration;
  ownPricesAtomic: number[];
  priceFairness: PriceFairness;
}

/**
 * Returns null for an unparseable address, a wallet with no ingested row,
 * or a demo row (is_demo=1) — same exclusion the public dashboard applies,
 * so a demo wallet can't get a real-looking profile URL. src/index.ts turns
 * null into a 404, not an error.
 */
export async function getMerchantProfileData(env: Env, rawAddress: string): Promise<MerchantProfileData | null> {
  const detected = detectAndNormalize(rawAddress);
  if (!detected) return null;

  const row = await getMerchantSignals(env, detected.normalized);
  if (!row) return null;
  // getMerchantSignals doesn't filter is_demo (it's also used by the paid
  // tool, which intentionally can look up demo rows for scripts/demo-
  // client.ts — see db/schema.sql is_demo comment) — this page is public,
  // so it applies the same is_demo exclusion the dashboard already does.
  if ((row as unknown as { is_demo?: number }).is_demo === 1) return null;

  const tier = (row.tier === "trusted" || row.tier === "caution" || row.tier === "avoid" ? row.tier : "caution") as Tier;
  const dataSufficiency: DataSufficiency = row.total_tx_count < MIN_TX_FOR_CONFIDENCE ? "INSUFFICIENT" : "SUFFICIENT";

  const ownPricesAtomic = await getOwnPrices(env, detected.normalized);
  const ownMedian = median(ownPricesAtomic);
  let priceFairness: PriceFairness = "unknown";
  if (ownMedian !== null && row.category) {
    const peerPrices = await getComparablePrices(env, row.category, detected.normalized);
    priceFairness = scorePriceFairness(ownMedian, peerPrices);
  }

  // bazaar_description isn't on MerchantSignalRow (schema.sql has it, the
  // shared type just never needed it until now) — narrow cast for that one
  // extra column rather than widening the type everywhere else reads it.
  const bazaarDescription = (row as unknown as { bazaar_description: string | null }).bazaar_description ?? null;

  return {
    walletAddress: row.wallet_address,
    chain: row.chain,
    network: row.network,
    tier,
    reasons: row.reasons_json ? JSON.parse(row.reasons_json) : [],
    totalTxCount: row.total_tx_count,
    uniquePayerCount: row.unique_payer_count,
    walletAgeDays: row.wallet_age_days,
    refreshedAt: row.refreshed_at,
    category: row.category,
    bazaarDescription,
    platforms: parsePlatforms(row.platforms_json),
    completedFlowCount: row.completed_flow_count,
    abandonedFlowCount: row.abandoned_flow_count,
    refundCount: row.refund_count,
    refundEligibleVolume: row.refund_eligible_volume,
    recommendation: deriveRecommendation(dataSufficiency, tier),
    confidence: deriveConfidence(row.total_tx_count),
    dataSufficiency,
    payerConcentration: derivePayerConcentration(row.unique_payer_count, row.total_tx_count),
    ownPricesAtomic,
    priceFairness,
  };
}

function statRow(label: string, value: string): string {
  return `<div class="stat-row"><span class="stat-row-label">${label}</span><span class="stat-row-value">${value}</span></div>`;
}

/** 404-ish page for an address that's well-formed but has no ingested row, or was found but excluded (demo). Same brand chrome as the found-merchant page so it doesn't feel like a broken link. */
export function renderMerchantNotFoundHtml(rawAddress: string): string {
  return `<title>Merchant not found | Gradient Decisions</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FONT_LINKS}
<style>
  :root { --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280; --accent: #4f46e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0b0d; --surface: #17171a; --border: #2a2a2e; --text: #f4f4f5; --text-dim: #9ca3af; --accent: #818cf8; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; line-height: 1.5; }
  ${BRAND_CSS}
  .wrap { max-width: 640px; margin: 0 auto; padding: 3.5rem 1.5rem; text-align: center; }
  .brand-row { display: flex; align-items: center; justify-content: center; gap: .55rem; margin-bottom: 1.5rem; }
  .brand-row .brand-mark { width: 34px; }
  h1 { font-size: 1.3rem; margin: 0 0 .6rem; }
  p { color: var(--text-dim); }
  code { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: .1rem .4rem; }
  a { color: var(--accent); }
</style>
<div class="wrap">
  <div class="brand-row">${renderMonogram("notfound-header", 34)}<h1>x402 Merchant Check</h1></div>
  <p>No indexed data for <code>${escapeHtml(rawAddress)}</code>.</p>
  <p>Either this isn't a valid Base or Solana wallet address, or it hasn't shown up in a refresh cycle yet.</p>
  <p><a href="/">← Back to the dashboard</a></p>
</div>`;
}

export function renderMerchantProfileHtml(data: MerchantProfileData): string {
  const recSlug = recommendationSlug(data.recommendation);
  const trustTier = toTrustTier(data.tier);
  const category = data.category ?? "uncategorized";
  const chainLabel = data.chain === "solana" ? "Solana" : "Base";

  const platformsHtml = data.platforms.length
    ? data.platforms
        .map((p) => {
          let hostname = p.url;
          try {
            hostname = new URL(p.url).hostname;
          } catch {
            // not a parseable absolute URL — show as-is
          }
          const label = escapeHtml(p.serviceName || hostname);
          return `<li><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${label}</a> <span class="pill-muted small">${escapeHtml(p.url)}</span></li>`;
        })
        .join("\n")
    : `<li class="pill-muted">No platforms ingested yet.</li>`;

  const reasonsHtml = data.reasons.length
    ? data.reasons.map((r) => `<span class="reason">${escapeHtml(r)}</span>`).join("")
    : `<span class="pill-muted small">No specific flags.</span>`;

  const totalFlows = data.completedFlowCount + data.abandonedFlowCount;

  return `<title>${escapeHtml(truncateAddress(data.walletAddress))} | x402 Merchant Check</title>
<meta name="description" content="Merchant profile for ${escapeHtml(data.walletAddress)}: trust recommendation, signals, and pricing from Gradient Decisions' x402 merchant check.">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
${FONT_LINKS}
<style>
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e4e4e7; --text: #18181b; --text-dim: #6b7280;
    --proceed: #16a34a; --proceed-bg: #dcfce7; --caution: #b45309; --caution-bg: #fef3c7;
    --insufficient: #6b7280; --insufficient-bg: #f1f1f3; --accent: #4f46e5;
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
  body { margin: 0; background: var(--bg); color: var(--text); font-family: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; line-height: 1.5; }
  ${BRAND_CSS}
  .wrap { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  .topbar { position: relative; height: 3px; background: var(--brand-gradient); margin: -2.5rem -1.5rem 2rem; }
  .brand-row { display: flex; align-items: center; gap: .55rem; margin-bottom: 1.25rem; }
  .brand-row .brand-mark { width: 30px; }
  .back-link { display: inline-block; margin-bottom: 1.25rem; color: var(--text-dim); text-decoration: none; font-size: .85rem; }
  .back-link:hover { text-decoration: underline; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  .profile-header { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-bottom: .5rem; }
  code.addr-full { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .95rem; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: .3rem .6rem; word-break: break-all; }
  .badge { display: inline-block; padding: .2rem .65rem; border-radius: 999px; font-size: .82rem; font-weight: 600; }
  .badge-proceed { background: var(--proceed-bg); color: var(--proceed); }
  .badge-caution { background: var(--caution-bg); color: var(--caution); }
  .badge-insufficient { background: var(--insufficient-bg); color: var(--insufficient); }
  .sub-line { color: var(--text-dim); font-size: .85rem; margin: .35rem 0 1.75rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.15rem 1.3rem; margin-bottom: 1rem; }
  .card h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin: 0 0 .85rem; }
  .stat-row { display: flex; justify-content: space-between; gap: 1rem; padding: .35rem 0; border-bottom: 1px solid var(--border); font-size: .88rem; }
  .stat-row:last-child { border-bottom: none; }
  .stat-row-label { color: var(--text-dim); }
  .stat-row-value { font-variant-numeric: tabular-nums; text-align: right; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 6px; font-size: .76rem; text-transform: capitalize; background: var(--bg); border: 1px solid var(--border); color: var(--text-dim); }
  .pill-muted { text-transform: none; }
  .pill-muted.small, span.small { font-size: .78rem; color: var(--text-dim); }
  .pill-fairness-fair { color: var(--proceed); border-color: var(--proceed); }
  .pill-fairness-high { color: var(--caution); border-color: var(--caution); }
  .pill-fairness-low { color: var(--accent); border-color: var(--accent); }
  .reason { display: inline-block; font-size: .8rem; color: var(--text-dim); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: .25rem .55rem; margin: .15rem .25rem .15rem 0; }
  ul.platforms { list-style: none; margin: 0; padding: 0; }
  ul.platforms li { padding: .4rem 0; border-bottom: 1px solid var(--border); font-size: .88rem; }
  ul.platforms li:last-child { border-bottom: none; }
  ul.platforms a { color: var(--accent); text-decoration: none; margin-right: .5rem; }
  ul.platforms a:hover { text-decoration: underline; }
  p.description { font-size: .88rem; color: var(--text-dim); margin: 0; }
  footer { margin-top: 2rem; color: var(--text-dim); font-size: .82rem; }
  .footer-brand { opacity: .55; margin-bottom: .85rem; }
  footer a { color: var(--accent); }
  code.small { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: .1rem .35rem; font-size: .82rem; }
</style>
<div class="topbar"></div>
<div class="wrap">
  <div class="brand-row">${renderMonogram("profile-header", 30)}<h1>x402 Merchant Check</h1></div>
  <a class="back-link" href="/">← All merchants</a>

  <div class="profile-header">
    <code class="addr-full">${escapeHtml(data.walletAddress)}</code>
    <span class="badge badge-${recSlug}" title="trust_tier: ${escapeHtml(trustTier)}">${recommendationLabel(data.recommendation)}</span>
    <span class="pill pill-chain">${escapeHtml(chainLabel)}</span>
    <span class="pill">${escapeHtml(category.replace(/_/g, " "))}</span>
  </div>
  <p class="sub-line">
    ${escapeHtml(data.confidence.toLowerCase())} confidence · ${escapeHtml(data.dataSufficiency.toLowerCase())} data ·
    last refreshed ${relativeTime(data.refreshedAt)}
  </p>

  <div class="card">
    <h2>Why</h2>
    ${reasonsHtml}
  </div>

  <div class="card">
    <h2>Signals</h2>
    ${statRow("Calls (30d)", data.totalTxCount.toLocaleString())}
    ${statRow("Unique payers", `${data.uniquePayerCount.toLocaleString()}${payerConcentrationLabel(data.payerConcentration)}`)}
    ${statRow("Wallet age", data.walletAgeDays !== null ? `${Math.floor(data.walletAgeDays)} days` : "unmeasured for this data source")}
    ${statRow("Settlement flows", totalFlows > 0 ? `${data.completedFlowCount.toLocaleString()} completed / ${data.abandonedFlowCount.toLocaleString()} abandoned` : "not visible from this data source")}
    ${statRow("Refunds", data.refundEligibleVolume > 0 ? `${data.refundCount.toLocaleString()} against ${data.refundEligibleVolume.toLocaleString()} eligible volume` : "no refund-eligible volume observed")}
  </div>

  <div class="card">
    <h2>Pricing</h2>
    ${statRow("Advertised price(s)", renderPriceCell(data.ownPricesAtomic, data.priceFairness))}
  </div>

  <div class="card">
    <h2>Platforms</h2>
    <ul class="platforms">${platformsHtml}</ul>
  </div>

  ${data.bazaarDescription ? `<div class="card"><h2>Listed description</h2><p class="description">${escapeHtml(data.bazaarDescription)}</p></div>` : ""}

  <footer>
    <div class="footer-brand">${renderWordmark("profile-footer", 120)}</div>
    Same signals a shopping agent gets via the <code class="small">check_merchant</code> MCP tool for this wallet.
    Not a certification, just an algorithmic read of public signals.
    Raw JSON: <a href="/api/wallets">/api/wallets</a>. <a href="/privacy">Privacy policy</a>.
  </footer>
</div>`;
}
