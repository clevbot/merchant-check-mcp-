import type { MerchantSignalRow, PriceFairness, Tier } from "./types";

export interface ScoringResult {
  tier: Tier;
  reasons: string[];
  /**
   * Short, machine-matchable codes parallel to `reasons` (same order, same
   * length after truncation) — added 2026-08-12 so callers (src/tool.ts)
   * can branch on which signal fired without parsing prose. Deliberately
   * does NOT include an entry for the insufficient-data early return below:
   * that's a data gap, not a behavioral risk finding, and conflating the
   * two was exactly the problem the recommendation/data_sufficiency split
   * in src/types.ts is meant to fix — see that file's Recommendation doc
   * comment.
   */
  riskFlags: string[];
}

/** Exported so src/tool.ts can compute data_sufficiency from the same threshold rather than a second hardcoded copy. */
export const MIN_TX_FOR_CONFIDENCE = 5;
const NEW_WALLET_DAYS = 14;
// Checked against the real reference set (2026-08-10, 365 live Bazaar
// merchants via BazaarDataSource): diversity ratio, not raw volume, is what
// actually separates the tiers in practice. The one real 'avoid' example
// sits at 0.05; 'caution' includes wallets with up to 92,878 calls but only
// 0.24 avg diversity; 'trusted' averages 0.56 despite far lower average
// volume (20.1 calls). 0.3 sits cleanly between those and isn't being
// changed — this is confirmation from real data, not a guess anymore.
/** Exported so src/tool.ts can derive `signals.payer_concentration` from the same number rather than a second hardcoded copy. */
export const LOW_PAYER_DIVERSITY_RATIO = 0.3; // unique_payers / total_tx below this looks like wash volume
// Added 2026-08-13 after a real, data-confirmed false-positive pattern: a
// pure ratio breaks down for high-frequency-use APIs (search/lookup
// resources an agent naturally calls many times per session — e.g. a
// Twitter search API with 84,158 calls from 51 distinct real payers, ratio
// 0.0006, well under LOW_PAYER_DIVERSITY_RATIO despite 51 real wallets
// having paid it). Checked the *live* production distribution before
// picking this, not guessed: PROCEED-recommendation Base merchants
// currently top out at 134 unique payers, while 46 CAUTION merchants
// (32 of them >=50) have MORE unique payers than that ceiling and were
// still flagged purely on ratio — including some with 400-759 unique
// payers, which is backwards for a "payer diversity" signal. 50 sits
// comfortably under PROCEED's natural top end (57, 68, 72, 134) while
// still being a real, hard-to-fake cost floor: reaching 50 distinct
// wallets that each made a real x402 payment isn't cheap to fabricate.
// Same epistemic status as LOW_PAYER_DIVERSITY_RATIO itself — grounded in
// a real observed distribution, not a proven-optimal number; revisit if
// the live distribution shifts meaningfully.
/** Exported so src/tool.ts's payer_concentration derivation applies the same override — otherwise signals.payer_concentration could say HIGH while risk_flags no longer contains low_payer_diversity, an internally contradictory response. */
export const MIN_PAYERS_FOR_BREADTH_OVERRIDE = 50;
const HIGH_ABANDON_RATE = 0.35;

/**
 * Rules-based v1 composite (per brief: "keep this rules-based and
 * explainable in v1"). Every flag pushed into `reasons` maps directly to
 * one of the six signals in db/schema.sql — do not add a flag here without
 * a corresponding, named signal.
 *
 * Reused unmodified for Solana rows (requirement 6, 2026-08-12) rather than
 * duplicated or given a parallel Solana-tuned version — but not every
 * threshold below is equally chain-neutral, so this is an explicit
 * signal-by-signal read, not a silent assumption that Base-tuned numbers
 * just work:
 * - Signal 1 (wallet age, calendar days) and signal 4 (refund count vs.
 *   volume) are chain-agnostic by construction — nothing in either depends
 *   on block time or throughput.
 * - Signal 2's ratio (unique_payers / total_tx) is dimensionless and should
 *   translate in principle, but LOW_PAYER_DIVERSITY_RATIO's specific value
 *   (0.3) was calibrated only against 365 real *Base* Bazaar merchants (see
 *   comment above) — it has not been checked against real Solana payer-
 *   diversity distributions. Treat it as an assumption pending Solana-
 *   specific validation once enough Helius-augmented Solana rows exist to
 *   check it against, not as a cross-chain-proven number.
 * - Signal 3 (completion/abandonment) and signal 5 (price variance) are
 *   currently 0 for every row on both chains — neither BazaarDataSource nor
 *   PayAIDataSource populates completedFlows/abandonedFlows, and per-payer
 *   price observations are empty from both sources too (see indexer.ts,
 *   solana-indexer.ts). Dormant equally everywhere, not a cross-chain risk
 *   yet.
 * - Signal 6 (velocity/harness-break) is the one signal known NOT to
 *   translate once it's implemented — Solana's ~4x faster finality means
 *   Base-tuned frequency thresholds would over-flag normal Solana activity.
 *   Currently stubbed (always 0) on both chains — see db/schema.sql
 *   velocity_anomaly_flag and README "Solana signal caveats".
 */
// "category" excluded deliberately: this function is pure trust-signal
// scoring and stays that way — category is a separate, additive concern
// (src/categorize) that never feeds tier/reasons. Not touched by the
// category/price-fairness work, just kept type-consistent with it.
export function scoreMerchant(row: Omit<MerchantSignalRow, "tier" | "reasons_json" | "category">): ScoringResult {
  const reasons: string[] = [];
  const riskFlags: string[] = [];

  if (row.total_tx_count < MIN_TX_FOR_CONFIDENCE) {
    return {
      tier: "caution",
      reasons: ["Insufficient transaction history to score confidently"],
      riskFlags: [],
    };
  }

  // Signal 1: wallet age
  if (row.wallet_age_days !== null && row.wallet_age_days < NEW_WALLET_DAYS) {
    reasons.push(`Wallet is only ${Math.floor(row.wallet_age_days)} days old`);
    riskFlags.push("new_wallet");
  }

  // Signal 2: payer diversity
  const diversityRatio =
    row.total_tx_count > 0 ? row.unique_payer_count / row.total_tx_count : 0;
  // MIN_PAYERS_FOR_BREADTH_OVERRIDE guards against exactly the failure mode
  // a high-frequency-use API produces: hundreds of real, distinct payers
  // each calling many times per session drives the ratio down without any
  // actual concentration risk — see that constant's own comment for the
  // real data behind this.
  if (diversityRatio < LOW_PAYER_DIVERSITY_RATIO && row.unique_payer_count < MIN_PAYERS_FOR_BREADTH_OVERRIDE) {
    reasons.push("Low payer diversity: volume concentrated among few payers");
    riskFlags.push("low_payer_diversity");
  }
  if (row.payer_cluster_flag) {
    reasons.push("Payer wallets show signs of clustering/linkage (possible wash volume)");
    riskFlags.push("payer_clustering");
  }

  // Signal 3: settlement completion
  const totalFlows = row.completed_flow_count + row.abandoned_flow_count;
  const abandonRate = totalFlows > 0 ? row.abandoned_flow_count / totalFlows : 0;
  if (totalFlows > 0 && abandonRate > HIGH_ABANDON_RATE) {
    reasons.push(
      `High abandoned-flow rate (${Math.round(abandonRate * 100)}% of quote→pay→deliver flows incomplete)`,
    );
    riskFlags.push("high_abandon_rate");
  }

  // Signal 4: refunds / recourse — zero refunds at high volume is itself a flag
  if (row.refund_count === 0 && row.refund_eligible_volume > 0 && row.total_tx_count > 20) {
    reasons.push("No visible recourse path: zero refunds despite meaningful volume");
    riskFlags.push("no_refund_recourse");
  }

  // Signal 5: price consistency
  if (row.price_variance_flag) {
    reasons.push("Same resource priced differently to different requesters");
    riskFlags.push("price_variance");
  }

  // Signal 6: velocity / harness-break anomalies (stubbed — see README)
  if (row.velocity_anomaly_flag) {
    reasons.push("Anomalous spike in volume or transaction size");
    riskFlags.push("velocity_anomaly");
  }

  let tier: Tier;
  if (reasons.length >= 2) {
    tier = "avoid";
  } else if (reasons.length === 1) {
    tier = "caution";
  } else {
    tier = "trusted";
    reasons.push("Consistent signals across wallet age, payer diversity, and settlement history");
  }

  // reasons/riskFlags are truncated in lockstep so each pair still lines up
  // by index — riskFlags never gained the "consistent signals" trusted-path
  // entry above (nothing to flag), so its slice is naturally <= reasons'.
  return { tier, reasons: reasons.slice(0, 3), riskFlags: riskFlags.slice(0, 3) };
}

/** Exported so callers (src/tool.ts, src/dashboard.ts) that need a representative single price from a wallet's own multiple price_observations rows use the same math scorePriceFairness does internally, rather than a third copy. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Added 2026-08-13, replacing an unvalidated ±25% band that was producing
// mostly noise against real data: checked live category price distributions
// (six categories, 392 priced merchants) and found real interquartile
// spread of roughly 2-5x the median in *each* direction within a single
// category (e.g. data_api's own real p75/median ≈2.75x, median/p25 ≈2.5x) —
// categories like "data_api" or "financial_data" bundle genuinely different
// kinds of resource at genuinely different price points, not one narrow
// market. Under the old ±25% band only 19% of real merchants landed on
// "fair"; these thresholds — grounded in the actual observed IQR, not
// guessed — produce 52% fair with high/low roughly balanced (99/91),
// which is what "most real prices are unremarkable, a real minority are
// outliers" should look like. Same epistemic status as
// LOW_PAYER_DIVERSITY_RATIO/MIN_PAYERS_FOR_BREADTH_OVERRIDE: real-data-
// grounded, not proven-optimal — the underlying category-coarseness this
// works around (very different resources sharing one of six category
// labels) is a real, separate limitation, not fixed by this alone. See
// README "Price fairness caveats".
const HIGH_PRICE_RATIO = 3.0; // 3x+ the category median
const LOW_PRICE_RATIO = 0.35; // 0.35x or less of the category median

export function scorePriceFairness(
  requestedPriceAtomic: number,
  comparablePricesAtomic: number[],
): PriceFairness {
  if (comparablePricesAtomic.length < 3) return "unknown";

  const medianPrice = median(comparablePricesAtomic)!;
  if (medianPrice === 0) return "unknown";
  const ratio = requestedPriceAtomic / medianPrice;

  if (ratio >= HIGH_PRICE_RATIO) return "high";
  if (ratio <= LOW_PRICE_RATIO) return "low";
  return "fair";
}
