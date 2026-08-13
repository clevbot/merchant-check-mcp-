import { describe, expect, it } from "vitest";
import { MIN_TX_FOR_CONFIDENCE, scoreMerchant, scorePriceFairness } from "../src/scoring";
import type { MerchantSignalRow } from "../src/types";

type Row = Omit<MerchantSignalRow, "tier" | "reasons_json" | "category">;

/** Minimal well-formed row, overridden per test — keeps each test's intent visible instead of repeating every field. */
function row(overrides: Partial<Row>): Row {
  return {
    wallet_address: "0xabc",
    first_seen_at: null,
    wallet_age_days: 365,
    unique_payer_count: 100,
    total_tx_count: 200,
    payer_cluster_flag: 0,
    completed_flow_count: 0,
    abandoned_flow_count: 0,
    refund_count: 0,
    refund_eligible_volume: 0,
    price_variance_flag: 0,
    velocity_anomaly_flag: 0,
    refreshed_at: 0,
    network: "eip155:8453",
    chain: "base",
    platforms_json: null,
    ...overrides,
  };
}

describe("scoreMerchant", () => {
  it("returns caution with no risk flags when transaction history is below MIN_TX_FOR_CONFIDENCE (insufficient data, not a behavioral concern)", () => {
    const result = scoreMerchant(row({ total_tx_count: MIN_TX_FOR_CONFIDENCE - 1, unique_payer_count: 1 }));
    expect(result.tier).toBe("caution");
    expect(result.riskFlags).toEqual([]);
    expect(result.reasons).toEqual(["Insufficient transaction history to score confidently"]);
  });

  it("returns trusted for an established, diverse merchant with no flags", () => {
    const result = scoreMerchant(row({ wallet_age_days: 365, unique_payer_count: 100, total_tx_count: 200 }));
    expect(result.tier).toBe("trusted");
    expect(result.riskFlags).toEqual([]);
    expect(result.reasons).toContain("Consistent signals across wallet age, payer diversity, and settlement history");
  });

  it("flags low_payer_diversity and lands on caution for concentrated payer behavior with otherwise clean signals", () => {
    // ratio = 5/200 = 0.025, well under LOW_PAYER_DIVERSITY_RATIO — one flag only.
    const result = scoreMerchant(row({ wallet_age_days: 365, unique_payer_count: 5, total_tx_count: 200 }));
    expect(result.tier).toBe("caution");
    expect(result.riskFlags).toEqual(["low_payer_diversity"]);
  });

  it("does NOT flag low_payer_diversity for a high-frequency-use API with many real distinct payers, even at a very low ratio (regression test — real production case: a Twitter search API, 84,158 calls / 51 payers, ratio 0.0006, was wrongly flagged before MIN_PAYERS_FOR_BREADTH_OVERRIDE was added)", () => {
    const result = scoreMerchant(row({ wallet_age_days: 365, unique_payer_count: 51, total_tx_count: 84158 }));
    expect(result.riskFlags).not.toContain("low_payer_diversity");
    expect(result.tier).toBe("trusted");
  });

  it("still flags low_payer_diversity for genuinely few payers even at high volume, below the breadth override floor", () => {
    // 49 payers is one under MIN_PAYERS_FOR_BREADTH_OVERRIDE (50) — should still flag.
    const result = scoreMerchant(row({ wallet_age_days: 365, unique_payer_count: 49, total_tx_count: 84158 }));
    expect(result.riskFlags).toContain("low_payer_diversity");
  });

  it("lands on avoid once two or more risk signals fire together", () => {
    // new wallet (< 14 days) AND concentrated payers -> two flags.
    const result = scoreMerchant(
      row({ wallet_age_days: 2, unique_payer_count: 5, total_tx_count: 200 }),
    );
    expect(result.tier).toBe("avoid");
    expect(result.riskFlags).toEqual(expect.arrayContaining(["new_wallet", "low_payer_diversity"]));
  });

  it("flags payer_clustering independently of the diversity ratio", () => {
    const result = scoreMerchant(
      row({ wallet_age_days: 365, unique_payer_count: 100, total_tx_count: 200, payer_cluster_flag: 1 }),
    );
    expect(result.riskFlags).toContain("payer_clustering");
  });

  it("truncates reasons and riskFlags in lockstep at 3 entries", () => {
    const result = scoreMerchant(
      row({
        wallet_age_days: 2, // new_wallet
        unique_payer_count: 1,
        total_tx_count: 200, // low_payer_diversity
        payer_cluster_flag: 1, // payer_clustering
        price_variance_flag: 1, // price_variance
        velocity_anomaly_flag: 1, // velocity_anomaly
      }),
    );
    expect(result.reasons.length).toBeLessThanOrEqual(3);
    expect(result.riskFlags.length).toBeLessThanOrEqual(3);
  });
});

describe("scorePriceFairness", () => {
  it("returns unknown with fewer than 3 comparable prices", () => {
    expect(scorePriceFairness(1000, [900, 1100])).toBe("unknown");
  });

  it("returns fair for a price close to the median", () => {
    expect(scorePriceFairness(1050, [1000, 1000, 1000])).toBe("fair");
  });

  it("returns fair even 2x-2.9x the median (real category price spread — see HIGH_PRICE_RATIO comment)", () => {
    expect(scorePriceFairness(2000, [1000, 1000, 1000])).toBe("fair");
    expect(scorePriceFairness(2900, [1000, 1000, 1000])).toBe("fair");
  });

  it("returns high at or above 3x the median", () => {
    expect(scorePriceFairness(3000, [1000, 1000, 1000])).toBe("high");
  });

  it("returns low at or below 0.35x the median", () => {
    expect(scorePriceFairness(350, [1000, 1000, 1000])).toBe("low");
  });
});
