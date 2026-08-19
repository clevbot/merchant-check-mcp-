import { tracing } from "cloudflare:workers";
import { LOW_PAYER_DIVERSITY_RATIO, MIN_PAYERS_FOR_BREADTH_OVERRIDE, MIN_TX_FOR_CONFIDENCE, median, scoreMerchant, scorePriceFairness } from "./scoring";
import { getComparablePrices, getMerchantSignals, getOwnPrices } from "./db/queries";
import { isMerchantCategory } from "./categorize/types";
import { detectAndNormalize } from "./chains";
import type {
  CheckMerchantInput,
  CheckMerchantOutput,
  Confidence,
  DataSufficiency,
  Env,
  MerchantPlatform,
  MerchantPricing,
  MerchantSignals,
  PayerConcentration,
  Recommendation,
  Tier,
  TrustTier,
} from "./types";

/** Parses db/schema.sql platforms_json — malformed/missing JSON returns an empty list rather than throwing, since this is additive context, not a scoring input. */
export function parsePlatforms(platformsJson: string | null): MerchantPlatform[] {
  if (!platformsJson) return [];
  try {
    const parsed = JSON.parse(platformsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Uppercase mirror of Tier, for the agent-facing `trust_tier` field — see types.ts TrustTier doc comment. */
export function toTrustTier(tier: Tier): TrustTier {
  if (tier === "trusted") return "TRUSTED";
  if (tier === "avoid") return "AVOID";
  return "CAUTION";
}

/**
 * PROCEED/CAUTION/INSUFFICIENT_SIGNAL — see types.ts Recommendation doc
 * comment for why this is a separate, smaller vocabulary than `trust_tier`.
 * Gated on data_sufficiency first: an `avoid`-tier read with real behavioral
 * concerns and a merely-thin-history `caution` read both collapse to
 * CAUTION here (not a REJECT/BLOCK level — see brief section 6 rationale in
 * README) since nothing in this pipeline currently produces evidence strong
 * enough to justify a harder recommendation than "the agent should look
 * closer," only `trust_tier`/`risk_flags` distinguish which kind of concern.
 */
export function deriveRecommendation(dataSufficiency: DataSufficiency, tier: Tier): Recommendation {
  if (dataSufficiency === "INSUFFICIENT") return "INSUFFICIENT_SIGNAL";
  return tier === "trusted" ? "PROCEED" : "CAUTION";
}

/**
 * Graduated read of how much evidence backs the recommendation, independent
 * of data_sufficiency's binary gate — a wallet can clear the sufficiency bar
 * (>= MIN_TX_FOR_CONFIDENCE) and still only warrant LOW confidence if it's
 * just barely over that line. Thresholds below are a reasonable first cut,
 * not calibrated against a labeled confidence dataset the way
 * LOW_PAYER_DIVERSITY_RATIO was — revisit once there's real signal on where
 * agents actually want the HIGH/MEDIUM boundary to sit.
 */
export function deriveConfidence(totalTxCount: number): Confidence {
  if (totalTxCount >= 50) return "HIGH";
  if (totalTxCount >= 15) return "MEDIUM";
  return "LOW";
}

/**
 * HIGH concentration = bad (few payers dominate volume) — inverse framing
 * from the internal diversity *ratio* on purpose, since "concentration" is
 * the more natural word for a risk-facing field. Reuses
 * LOW_PAYER_DIVERSITY_RATIO as the HIGH-concentration cutoff so this can
 * never silently drift out of sync with the actual low_payer_diversity
 * risk flag in src/scoring.ts. The upper (LOW-concentration) cutoff is a
 * reasonable-but-not-separately-validated 2x that line — same caveat as
 * deriveConfidence above.
 *
 * Also applies MIN_PAYERS_FOR_BREADTH_OVERRIDE, same as scoreMerchant's own
 * signal 2 (added 2026-08-13, real production data found the ratio alone
 * mis-flags high-frequency-use APIs with hundreds of real distinct payers —
 * see that constant's comment) — without this, a merchant that no longer
 * triggers the low_payer_diversity risk flag could still show
 * payer_concentration: "HIGH" here, an internally contradictory response.
 */
export function derivePayerConcentration(uniquePayers: number, totalTxCount: number): PayerConcentration {
  if (totalTxCount === 0) return "UNKNOWN";
  if (uniquePayers >= MIN_PAYERS_FOR_BREADTH_OVERRIDE) return "LOW";
  const ratio = uniquePayers / totalTxCount;
  if (ratio < LOW_PAYER_DIVERSITY_RATIO) return "HIGH";
  if (ratio < LOW_PAYER_DIVERSITY_RATIO * 2) return "MEDIUM";
  return "LOW";
}

/**
 * Core check_merchant logic. Reads only from the precomputed D1 store — no
 * chain access here, that's the whole point of the refresh-worker split
 * (see src/refresh). Keeps this handler fast enough to run inside a paid,
 * per-request Worker invocation.
 *
 * "chain" above (Solana/Base network) is unrelated to "on-chain" in the
 * comment below — this function does no blockchain reads at all, on either
 * chain, at request time.
 *
 * Output reworked 2026-08-12 into a pre-payment decision primitive (see
 * README "Pre-payment decision primitive"): `recommendation` is what an
 * agent's payment policy should actually branch on, everything else
 * (trust_tier, signals, risk_flags, reasons) is supporting detail for
 * policies that want more than the three-way split.
 */
/**
 * Cloudflare agent tracing (2026-08-19, https://developers.cloudflare.com/agent-setup/tracing.md)
 * — this project has no Think/Flue/AI SDK agent loop (see the "Revisited
 * 2026-08-19" addendum on the MCP-stack comment near the top of
 * src/index.ts for why not, and why that's the right call), so it falls
 * into the doc's "Custom" bucket: instrument with the Workers custom spans
 * API directly.
 *
 * Corrected same day, after the user pointed at the dashboard's "Agents"
 * rollup page (Agents/Sessions/Runs/Tokens) and it showed all zeros: that
 * view specifically counts `invoke_agent` spans carrying
 * `gen_ai.agent.name`/`gen_ai.agent.id`/`gen_ai.conversation.id` as its
 * unit of a "Run" — a bare top-level `execute_tool` span (the original
 * version of this comment's reasoning: "we're the tool being called, not
 * the agent") is semantically defensible under the strict OTel GenAI
 * convention, but it structurally can never populate that specific page,
 * regardless of real traffic. Fixed by wrapping the same `execute_tool`
 * span in an outer `invoke_agent` span representing the turn — this
 * server's identity ("merchant-check-mcp") stands in as "the agent" for
 * Cloudflare's dashboard vocabulary, which is the pragmatic reading the
 * UI wants, not a claim that this Worker reasons autonomously. Each call
 * is its own one-turn session (no cross-call state — see README "Pre-
 * payment decision primitive"), so `gen_ai.conversation.id` is a fresh
 * `crypto.randomUUID()` per invocation, not a persisted value.
 *
 * Attributes stay non-identifying-of-the-caller: merchant wallet address,
 * chain, category, and recommendation are already disclosed/logged
 * elsewhere (query_log, the privacy policy's "merchant wallet data"
 * section) and describe the *merchant* being evaluated, a public
 * on-chain identity, not the caller. The caller's own wallet address is
 * captured separately (query_log.payer_address via onAfterSettlement /
 * GET /check's settlement) and deliberately kept out of trace attributes
 * here, since this function never sees it.
 */
export async function checkMerchant(env: Env, input: CheckMerchantInput): Promise<CheckMerchantOutput> {
  return tracing.enterSpan("invoke_agent", async (turnSpan) => {
    turnSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "merchant-check-mcp",
      "gen_ai.agent.id": "check_merchant",
      "gen_ai.conversation.id": crypto.randomUUID(),
    });
    return tracing.enterSpan("execute_tool", async (toolSpan) => {
      toolSpan.setAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "check_merchant",
      });
      const output = await checkMerchantImpl(env, input);
      toolSpan.setAttributes({
        "check_merchant.merchant_wallet_address": output.merchant,
        "check_merchant.chain": output.chain ?? "unknown",
        "check_merchant.category": output.category ?? "unknown",
        "check_merchant.recommendation": output.recommendation,
        "check_merchant.data_sufficiency": output.data_sufficiency,
      });
      return output;
    });
  });
}

async function checkMerchantImpl(
  env: Env,
  input: CheckMerchantInput,
): Promise<CheckMerchantOutput> {
  const detected = detectAndNormalize(input.merchant_wallet_address);
  if (!detected) {
    return {
      merchant: input.merchant_wallet_address,
      network: null,
      recommendation: "INSUFFICIENT_SIGNAL",
      trust_tier: null,
      confidence: "LOW",
      data_sufficiency: "INSUFFICIENT",
      signals: { merchant_age_days: null, unique_payers: 0, total_tx_count: 0, payer_concentration: "UNKNOWN" },
      risk_flags: [],
      reasons: ["merchant_wallet_address is not a recognized Base or Solana address — cannot score"],
      price_fairness: "unknown",
      pricing: { advertised_prices_atomic: [], fairness_vs_category: "unknown" },
      category: null,
      chain: null,
      platforms: [],
    };
  }
  const { chain, normalized } = detected;

  const row = await getMerchantSignals(env, normalized);

  if (!row) {
    return {
      merchant: normalized,
      network: null,
      recommendation: "INSUFFICIENT_SIGNAL",
      trust_tier: null,
      confidence: "LOW",
      data_sufficiency: "INSUFFICIENT",
      signals: { merchant_age_days: null, unique_payers: 0, total_tx_count: 0, payer_concentration: "UNKNOWN" },
      risk_flags: [],
      reasons: ["No transaction history found for this wallet on indexed rails"],
      price_fairness: "unknown",
      pricing: { advertised_prices_atomic: [], fairness_vs_category: "unknown" },
      category: null,
      chain,
      platforms: [],
    };
  }

  const { tier, reasons, riskFlags } = scoreMerchant(row);
  const category = row.category && isMerchantCategory(row.category) ? row.category : null;

  // Category peers are fetched at most once and shared by both price
  // comparisons below (price_fairness for a caller-supplied price, pricing
  // for the merchant's own advertised price) — avoids two identical D1
  // queries in the case where both apply, which matters given the brief's
  // own "unnecessary repeated queries" economics ask (section 10).
  const ownPricesAtomic = await getOwnPrices(env, normalized);
  const ownMedian = median(ownPricesAtomic);
  const needsCategoryPeers = category !== null && (input.price !== undefined || ownMedian !== null);
  const categoryPeers = needsCategoryPeers ? await getComparablePrices(env, category!, normalized) : [];

  // Price-fairness compares a *caller-supplied* price against the merchant's
  // own `category`, not the caller-supplied resource_type (kept in the input
  // schema for backward compatibility, but no longer required or used here)
  // — category is the only bucket real Bazaar-sourced price data actually
  // exists for. See src/refresh/index.ts upsertCategoryPriceObservations.
  let priceFairness: CheckMerchantOutput["price_fairness"] = "unknown";
  if (input.price !== undefined && category) {
    // price is USD-equivalent float from the caller; store/compare in atomic
    // USDC units (6 decimals) to match price_observations. Both Base USDC and
    // Solana USDC use 6 decimals, so this atomic comparison is valid across
    // chains within the same category — see getComparablePrices in
    // src/db/queries.ts.
    const requestedAtomic = Math.round(input.price * 1_000_000);
    priceFairness = scorePriceFairness(requestedAtomic, categoryPeers);
  }

  // Unconditional pricing context — added 2026-08-13 alongside price_fairness
  // above, not a replacement for it: price_fairness answers "is the price a
  // caller was quoted fair", pricing answers "what does this merchant
  // generally charge and how does that compare", with no caller input
  // needed. Reuses the exact same comparison math (median + scorePriceFairness)
  // as price_fairness and the dashboard's own price column (src/dashboard.ts)
  // rather than a fourth copy of this logic.
  const fairnessVsCategory: CheckMerchantOutput["pricing"]["fairness_vs_category"] =
    ownMedian !== null && category ? scorePriceFairness(ownMedian, categoryPeers) : "unknown";
  const pricing: MerchantPricing = { advertised_prices_atomic: ownPricesAtomic, fairness_vs_category: fairnessVsCategory };

  const dataSufficiency: DataSufficiency = row.total_tx_count < MIN_TX_FOR_CONFIDENCE ? "INSUFFICIENT" : "SUFFICIENT";
  const signals: MerchantSignals = {
    merchant_age_days: row.wallet_age_days !== null ? Math.floor(row.wallet_age_days) : null,
    unique_payers: row.unique_payer_count,
    total_tx_count: row.total_tx_count,
    payer_concentration: derivePayerConcentration(row.unique_payer_count, row.total_tx_count),
  };

  return {
    merchant: normalized,
    network: row.network,
    recommendation: deriveRecommendation(dataSufficiency, tier),
    trust_tier: toTrustTier(tier),
    confidence: deriveConfidence(row.total_tx_count),
    data_sufficiency: dataSufficiency,
    signals,
    risk_flags: riskFlags,
    reasons,
    price_fairness: priceFairness,
    pricing,
    category,
    chain,
    platforms: parsePlatforms(row.platforms_json),
  };
}
