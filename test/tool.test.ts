import { describe, expect, it } from "vitest";
import { checkMerchant, deriveConfidence, deriveRecommendation, derivePayerConcentration, parsePlatforms, toTrustTier } from "../src/tool";
import type { Env, MerchantSignalRow } from "../src/types";

// --- pure helper unit tests -------------------------------------------------

describe("deriveRecommendation", () => {
  it("returns INSUFFICIENT_SIGNAL whenever data is insufficient, regardless of tier", () => {
    expect(deriveRecommendation("INSUFFICIENT", "trusted")).toBe("INSUFFICIENT_SIGNAL");
    expect(deriveRecommendation("INSUFFICIENT", "avoid")).toBe("INSUFFICIENT_SIGNAL");
  });

  it("returns PROCEED for a trusted tier with sufficient data", () => {
    expect(deriveRecommendation("SUFFICIENT", "trusted")).toBe("PROCEED");
  });

  it("returns CAUTION for caution or avoid tiers with sufficient data (never a REJECT/BLOCK value)", () => {
    expect(deriveRecommendation("SUFFICIENT", "caution")).toBe("CAUTION");
    expect(deriveRecommendation("SUFFICIENT", "avoid")).toBe("CAUTION");
  });
});

describe("toTrustTier", () => {
  it("uppercases each tier value", () => {
    expect(toTrustTier("trusted")).toBe("TRUSTED");
    expect(toTrustTier("caution")).toBe("CAUTION");
    expect(toTrustTier("avoid")).toBe("AVOID");
  });
});

describe("deriveConfidence", () => {
  it("buckets by transaction volume", () => {
    expect(deriveConfidence(0)).toBe("LOW");
    expect(deriveConfidence(14)).toBe("LOW");
    expect(deriveConfidence(15)).toBe("MEDIUM");
    expect(deriveConfidence(49)).toBe("MEDIUM");
    expect(deriveConfidence(50)).toBe("HIGH");
  });
});

describe("derivePayerConcentration", () => {
  it("returns UNKNOWN with zero transactions", () => {
    expect(derivePayerConcentration(0, 0)).toBe("UNKNOWN");
  });

  it("returns HIGH concentration for a low diversity ratio", () => {
    expect(derivePayerConcentration(1, 100)).toBe("HIGH");
  });

  it("returns LOW concentration for a broad payer base", () => {
    expect(derivePayerConcentration(80, 100)).toBe("LOW");
  });

  it("returns LOW concentration once absolute payer count clears the breadth override, even at a very low ratio", () => {
    // Same real production case as scoring.test.ts's regression test: 51
    // payers / 84,158 calls, ratio 0.0006 — would be HIGH under ratio alone.
    expect(derivePayerConcentration(51, 84158)).toBe("LOW");
  });
});

describe("parsePlatforms", () => {
  it("returns an empty array for null input", () => {
    expect(parsePlatforms(null)).toEqual([]);
  });

  it("returns an empty array for malformed JSON rather than throwing", () => {
    expect(parsePlatforms("{not valid json")).toEqual([]);
  });

  it("parses a well-formed platforms array", () => {
    const json = JSON.stringify([{ url: "https://example.com", serviceName: "Example" }]);
    expect(parsePlatforms(json)).toEqual([{ url: "https://example.com", serviceName: "Example" }]);
  });
});

// --- checkMerchant integration tests, against a hand-written fake D1 -------

interface FakePriceRow {
  wallet_address: string;
  category: string;
  price_atomic: number;
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private sql: string,
    private merchantSignals: Record<string, MerchantSignalRow>,
    private priceObservations: FakePriceRow[],
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM merchant_signals")) {
      const wallet = this.args[0] as string;
      return (this.merchantSignals[wallet] as unknown as T) ?? null;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM price_observations")) {
      // Distinguish getOwnPrices ("wallet_address = ?") from
      // getComparablePrices ("wallet_address != ?") by SQL shape, same as
      // the two real queries in src/db/queries.ts differ.
      if (this.sql.includes("wallet_address = ?")) {
        const wallet = this.args[0] as string;
        return { results: this.priceObservations.filter((p) => p.wallet_address === wallet) as unknown as T[] };
      }
      if (this.sql.includes("wallet_address != ?")) {
        const [category, excludeWallet] = this.args as [string, string];
        return {
          results: this.priceObservations.filter((p) => p.category === category && p.wallet_address !== excludeWallet) as unknown as T[],
        };
      }
    }
    return { results: [] };
  }
  async run(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

function fakeEnv(merchantSignals: Record<string, MerchantSignalRow>, priceObservations: FakePriceRow[] = []): Env {
  const DB = {
    prepare(sql: string) {
      return new FakeStatement(sql, merchantSignals, priceObservations);
    },
  };
  return {
    DB: DB as unknown as Env["DB"],
    X402_NETWORK: "eip155:8453",
    PAYOUT_ADDRESS: "0x0000000000000000000000000000000000000000",
    ADMIN_TOKEN: "test-token",
  };
}

function fixtureRow(overrides: Partial<MerchantSignalRow>): MerchantSignalRow {
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
    tier: null,
    reasons_json: null,
    refreshed_at: 0,
    network: "eip155:8453",
    chain: "base",
    category: null,
    platforms_json: null,
    ...overrides,
  };
}

const VALID_BASE_ADDRESS = "0xffc458db291b4abce020fe3de4f91f2770e537b1";

describe("checkMerchant", () => {
  it("returns INSUFFICIENT_SIGNAL with null chain/trust_tier for a malformed address", async () => {
    const result = await checkMerchant(fakeEnv({}), { merchant_wallet_address: "not-an-address" });
    expect(result.recommendation).toBe("INSUFFICIENT_SIGNAL");
    expect(result.chain).toBeNull();
    expect(result.trust_tier).toBeNull();
    expect(result.data_sufficiency).toBe("INSUFFICIENT");
  });

  it("returns INSUFFICIENT_SIGNAL for a valid but unindexed address (no D1 row)", async () => {
    const result = await checkMerchant(fakeEnv({}), { merchant_wallet_address: VALID_BASE_ADDRESS });
    expect(result.recommendation).toBe("INSUFFICIENT_SIGNAL");
    expect(result.chain).toBe("base");
    expect(result.trust_tier).toBeNull();
    expect(result.merchant).toBe(VALID_BASE_ADDRESS);
  });

  it("returns PROCEED for an established, diverse merchant", async () => {
    const env = fakeEnv({
      // ratio 150/200 = 0.75 -> >= LOW_PAYER_DIVERSITY_RATIO*2 (0.6) -> LOW concentration, no risk flag.
      [VALID_BASE_ADDRESS]: fixtureRow({
        wallet_address: VALID_BASE_ADDRESS,
        unique_payer_count: 150,
        total_tx_count: 200,
        wallet_age_days: 365,
      }),
    });
    const result = await checkMerchant(env, { merchant_wallet_address: VALID_BASE_ADDRESS });
    expect(result.recommendation).toBe("PROCEED");
    expect(result.trust_tier).toBe("TRUSTED");
    expect(result.data_sufficiency).toBe("SUFFICIENT");
    expect(result.risk_flags).toEqual([]);
    expect(result.signals.total_tx_count).toBe(200);
    expect(result.signals.payer_concentration).toBe("LOW");
  });

  it("returns INSUFFICIENT_SIGNAL for a wallet with a D1 row but thin transaction history", async () => {
    const env = fakeEnv({
      [VALID_BASE_ADDRESS]: fixtureRow({ wallet_address: VALID_BASE_ADDRESS, total_tx_count: 2, unique_payer_count: 1 }),
    });
    const result = await checkMerchant(env, { merchant_wallet_address: VALID_BASE_ADDRESS });
    expect(result.recommendation).toBe("INSUFFICIENT_SIGNAL");
    expect(result.data_sufficiency).toBe("INSUFFICIENT");
  });

  it("returns CAUTION with risk_flags populated for a concentrated-payer merchant", async () => {
    const env = fakeEnv({
      [VALID_BASE_ADDRESS]: fixtureRow({
        wallet_address: VALID_BASE_ADDRESS,
        unique_payer_count: 2,
        total_tx_count: 200,
        wallet_age_days: 365,
      }),
    });
    const result = await checkMerchant(env, { merchant_wallet_address: VALID_BASE_ADDRESS });
    expect(result.recommendation).toBe("CAUTION");
    expect(result.trust_tier).toBe("CAUTION");
    expect(result.risk_flags).toContain("low_payer_diversity");
    expect(result.signals.payer_concentration).toBe("HIGH");
  });

  it("preserves a Solana address's case throughout the response", async () => {
    const solanaAddress = "DdeMfXrDae49VAkvVZHUhWh7FDuirAuFCuuJruqXv5G2";
    const env = fakeEnv({
      [solanaAddress]: fixtureRow({
        wallet_address: solanaAddress,
        chain: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        unique_payer_count: 20,
        total_tx_count: 40,
      }),
    });
    const result = await checkMerchant(env, { merchant_wallet_address: solanaAddress });
    expect(result.merchant).toBe(solanaAddress); // exact case preserved, not lowercased
    expect(result.chain).toBe("solana");
  });

  it("always returns the full response shape regardless of path taken", async () => {
    const result = await checkMerchant(fakeEnv({}), { merchant_wallet_address: "garbage" });
    const expectedKeys = [
      "merchant",
      "network",
      "recommendation",
      "trust_tier",
      "confidence",
      "data_sufficiency",
      "signals",
      "risk_flags",
      "reasons",
      "price_fairness",
      "pricing",
      "category",
      "chain",
      "platforms",
    ];
    for (const key of expectedKeys) {
      expect(result).toHaveProperty(key);
    }
    expect(result.pricing).toEqual({ advertised_prices_atomic: [], fairness_vs_category: "unknown" });
  });

  it("surfaces the merchant's own advertised prices unconditionally, without a caller-supplied price", async () => {
    const env = fakeEnv(
      { [VALID_BASE_ADDRESS]: fixtureRow({ wallet_address: VALID_BASE_ADDRESS, category: "data_api" }) },
      [{ wallet_address: VALID_BASE_ADDRESS, category: "data_api", price_atomic: 10_000 }],
    );
    const result = await checkMerchant(env, { merchant_wallet_address: VALID_BASE_ADDRESS });
    expect(result.pricing.advertised_prices_atomic).toEqual([10_000]);
    // Only 1 comparable peer price exists (none, in fact) -> scorePriceFairness needs >=3 -> unknown.
    expect(result.pricing.fairness_vs_category).toBe("unknown");
  });

  it("computes fairness_vs_category against category peers, excluding the merchant's own rows", async () => {
    const env = fakeEnv(
      { [VALID_BASE_ADDRESS]: fixtureRow({ wallet_address: VALID_BASE_ADDRESS, category: "data_api" }) },
      [
        { wallet_address: VALID_BASE_ADDRESS, category: "data_api", price_atomic: 50_000 }, // this merchant: $0.05
        { wallet_address: "0xpeer1", category: "data_api", price_atomic: 10_000 },
        { wallet_address: "0xpeer2", category: "data_api", price_atomic: 10_000 },
        { wallet_address: "0xpeer3", category: "data_api", price_atomic: 10_000 },
      ],
    );
    const result = await checkMerchant(env, { merchant_wallet_address: VALID_BASE_ADDRESS });
    // $0.05 vs a $0.01 peer median -> ratio 5.0, well above the 1.25 "high" cutoff.
    expect(result.pricing.fairness_vs_category).toBe("high");
  });

  it("still computes price_fairness for a caller-supplied price independently of pricing.fairness_vs_category", async () => {
    const env = fakeEnv(
      { [VALID_BASE_ADDRESS]: fixtureRow({ wallet_address: VALID_BASE_ADDRESS, category: "data_api" }) },
      [
        { wallet_address: "0xpeer1", category: "data_api", price_atomic: 10_000 },
        { wallet_address: "0xpeer2", category: "data_api", price_atomic: 10_000 },
        { wallet_address: "0xpeer3", category: "data_api", price_atomic: 10_000 },
      ],
    );
    const result = await checkMerchant(env, { merchant_wallet_address: VALID_BASE_ADDRESS, price: 0.01 });
    expect(result.price_fairness).toBe("fair");
    // No price_observations rows for this wallet itself -> pricing stays empty/unknown, independent of price_fairness above.
    expect(result.pricing.advertised_prices_atomic).toEqual([]);
    expect(result.pricing.fairness_vs_category).toBe("unknown");
  });
});
