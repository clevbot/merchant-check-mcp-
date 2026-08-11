import type { MerchantSignalRow, PriceFairness, Tier } from "./types";

export interface ScoringResult {
  tier: Tier;
  reasons: string[];
}

const MIN_TX_FOR_CONFIDENCE = 5;
const NEW_WALLET_DAYS = 14;
// Checked against the real reference set (2026-08-10, 365 live Bazaar
// merchants via BazaarDataSource): diversity ratio, not raw volume, is what
// actually separates the tiers in practice. The one real 'avoid' example
// sits at 0.05; 'caution' includes wallets with up to 92,878 calls but only
// 0.24 avg diversity; 'trusted' averages 0.56 despite far lower average
// volume (20.1 calls). 0.3 sits cleanly between those and isn't being
// changed — this is confirmation from real data, not a guess anymore.
const LOW_PAYER_DIVERSITY_RATIO = 0.3; // unique_payers / total_tx below this looks like wash volume
const HIGH_ABANDON_RATE = 0.35;

/**
 * Rules-based v1 composite (per brief: "keep this rules-based and
 * explainable in v1"). Every flag pushed into `reasons` maps directly to
 * one of the six signals in db/schema.sql — do not add a flag here without
 * a corresponding, named signal.
 */
// "category" excluded deliberately: this function is pure trust-signal
// scoring and stays that way — category is a separate, additive concern
// (src/categorize) that never feeds tier/reasons. Not touched by the
// category/price-fairness work, just kept type-consistent with it.
export function scoreMerchant(row: Omit<MerchantSignalRow, "tier" | "reasons_json" | "category">): ScoringResult {
  const reasons: string[] = [];

  if (row.total_tx_count < MIN_TX_FOR_CONFIDENCE) {
    return {
      tier: "caution",
      reasons: ["Insufficient transaction history to score confidently"],
    };
  }

  // Signal 1: wallet age
  if (row.wallet_age_days !== null && row.wallet_age_days < NEW_WALLET_DAYS) {
    reasons.push(`Wallet is only ${Math.floor(row.wallet_age_days)} days old`);
  }

  // Signal 2: payer diversity
  const diversityRatio =
    row.total_tx_count > 0 ? row.unique_payer_count / row.total_tx_count : 0;
  if (diversityRatio < LOW_PAYER_DIVERSITY_RATIO) {
    reasons.push("Low payer diversity — volume concentrated among few payers");
  }
  if (row.payer_cluster_flag) {
    reasons.push("Payer wallets show signs of clustering/linkage (possible wash volume)");
  }

  // Signal 3: settlement completion
  const totalFlows = row.completed_flow_count + row.abandoned_flow_count;
  const abandonRate = totalFlows > 0 ? row.abandoned_flow_count / totalFlows : 0;
  if (totalFlows > 0 && abandonRate > HIGH_ABANDON_RATE) {
    reasons.push(
      `High abandoned-flow rate (${Math.round(abandonRate * 100)}% of quote→pay→deliver flows incomplete)`,
    );
  }

  // Signal 4: refunds / recourse — zero refunds at high volume is itself a flag
  if (row.refund_count === 0 && row.refund_eligible_volume > 0 && row.total_tx_count > 20) {
    reasons.push("No visible recourse path — zero refunds despite meaningful volume");
  }

  // Signal 5: price consistency
  if (row.price_variance_flag) {
    reasons.push("Same resource priced differently to different requesters");
  }

  // Signal 6: velocity / harness-break anomalies (stubbed — see README)
  if (row.velocity_anomaly_flag) {
    reasons.push("Anomalous spike in volume or transaction size");
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

  return { tier, reasons: reasons.slice(0, 3) };
}

export function scorePriceFairness(
  requestedPriceAtomic: number,
  comparablePricesAtomic: number[],
): PriceFairness {
  if (comparablePricesAtomic.length < 3) return "unknown";

  const sorted = [...comparablePricesAtomic].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;

  if (median === 0) return "unknown";
  const ratio = requestedPriceAtomic / median;

  if (ratio >= 1.25) return "high";
  if (ratio <= 0.75) return "low";
  return "fair";
}
