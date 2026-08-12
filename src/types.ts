export interface Env {
  DB: D1Database;
  /** CAIP-2 format, e.g. "eip155:84532" (Base Sepolia) or "eip155:8453" (Base mainnet). */
  X402_NETWORK: string;
  /** Set via `wrangler secret put PAYOUT_ADDRESS` — see README "Before this can run". */
  PAYOUT_ADDRESS: string;
  /** Set via `wrangler secret put ADMIN_TOKEN` — gates POST /refresh and POST /categorize (see src/index.ts). */
  ADMIN_TOKEN: string;
  /**
   * Set via `wrangler secret put ANTHROPIC_API_KEY` — powers the pass-2
   * model fallback in src/categorize/model.ts. Optional: unset means every
   * description the rule pass can't confidently place lands in 'other'
   * (logged for review) instead of erroring — see README "Categorization".
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Set via `wrangler secret put CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` —
   * required for real mainnet settlement (see src/index.ts getResourceServer
   * and README "Going to mainnet"). The free public x402.org facilitator is
   * testnet-only; Base mainnet needs Coinbase's authenticated CDP
   * production facilitator. Optional in the type only because the app must
   * still boot without them — verify/settle calls fail clearly without
   * these set, rather than silently using an unauthenticated endpoint.
   */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /**
   * Set via `wrangler secret put HELIUS_API_KEY` — powers Solana transfer
   * indexing in src/refresh/solana-indexer.ts (see README "Solana data
   * source"). Optional: unset means Solana wallets get real discovery/
   * pricing/category from PayAI's feed but no payer-diversity data, so
   * trust-tier stays "insufficient data" for them rather than guessing.
   */
  HELIUS_API_KEY?: string;
}

import type { MerchantCategory } from "./categorize/types";
import type { Chain } from "./chains";

export type Tier = "trusted" | "caution" | "avoid";
export type PriceFairness = "fair" | "high" | "low" | "unknown";

/**
 * Agent-facing action vocabulary (2026-08-12 rework — see README "Pre-payment
 * decision primitive"). Deliberately small and deterministic: an agent's
 * payment policy should be able to switch on this string directly without
 * interpreting `trust_tier`, `signals`, or `reasons` itself. Distinct from
 * `Tier`/`trust_tier` on purpose — INSUFFICIENT_SIGNAL is not the same
 * epistemic state as CAUTION (see `data_sufficiency` below): "we don't have
 * enough history to say anything" and "we have real behavioral concerns"
 * are different claims and were previously collapsed into one `caution`
 * value. No REJECT/BLOCK value exists — nothing in this pipeline currently
 * produces evidence strong enough to justify a hard block (see
 * db/schema.sql `avoid` bucket note in scripts/labeled-wallets.json); adding
 * one without that evidence would just be a stronger-sounding guess.
 */
export type Recommendation = "PROCEED" | "CAUTION" | "INSUFFICIENT_SIGNAL";
/** Uppercase, agent-facing mirror of `Tier` — kept as a distinct type (not just Tier.toUpperCase()) so richer detail stays available to callers whose policy wants more than the three-way `recommendation`. */
export type TrustTier = "TRUSTED" | "CAUTION" | "AVOID";
/** How much evidence backs the recommendation — separate from `data_sufficiency`: sufficiency is the gate (do we have the minimum to say anything at all), confidence is graduated (how much beyond that minimum do we actually have). */
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type DataSufficiency = "SUFFICIENT" | "INSUFFICIENT";
export type PayerConcentration = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface CheckMerchantInput {
  merchant_wallet_address: string;
  price?: number;
  /**
   * Accepted for backward compatibility but no longer required for
   * price_fairness to compute — see src/tool.ts. The actual comparison
   * bucket is the merchant's own `category`, since that's the only thing
   * real Bazaar-sourced data can support; a caller-supplied goods-category
   * string was never populated against anything and stayed silently inert.
   */
  resource_type?: string;
  /**
   * Optional x402-flow context (2026-08-12, brief section 3) — accepted but
   * not currently required for scoring, which stays keyed on the wallet
   * address alone. Exists so an agent can pass through fields it already
   * has in hand straight from a 402 Payment Required response's `accepts[]`
   * entry (network, asset, amount) or the resource it was trying to reach
   * (service_url), without needing to strip them back out first. Reserved
   * for future use (e.g. network-mismatch warnings) rather than silently
   * ignored-and-undocumented.
   */
  network?: string;
  asset?: string;
  amount?: string;
  service_url?: string;
}

/** One resource (API/service endpoint) a merchant wallet backs — see db/schema.sql platforms_json. */
export interface MerchantPlatform {
  url: string;
  serviceName: string | null;
}

/** Structured, agent-parseable signal snapshot — the numbers behind `recommendation`, not prose. Nulls/"UNKNOWN" are honest gaps, never a fabricated value (see src/tool.ts deriveSignals). */
export interface MerchantSignals {
  merchant_age_days: number | null;
  unique_payers: number;
  total_tx_count: number;
  payer_concentration: PayerConcentration;
}

export interface CheckMerchantOutput {
  merchant: string;
  /** CAIP-2 network id, e.g. "eip155:8453" — null only alongside chain:null (invalid-address path). */
  network: string | null;
  /**
   * The field a payment policy should actually switch on — see
   * `Recommendation`'s own doc comment for why this is distinct from
   * `trust_tier`.
   */
  recommendation: Recommendation;
  /** Richer detail than `recommendation`; null only for the invalid-address early-return path. */
  trust_tier: TrustTier | null;
  confidence: Confidence;
  data_sufficiency: DataSufficiency;
  signals: MerchantSignals;
  /** Short machine-matchable flags (e.g. "low_payer_diversity") — parallel to `reasons` but for code, not display. Empty array, not null, when nothing fired. */
  risk_flags: string[];
  /** Human-readable versions of the same underlying signals as risk_flags — kept for the dashboard and for agents that want prose in a log/explanation, not for policy branching (use recommendation or risk_flags for that). */
  reasons: string[];
  price_fairness: PriceFairness;
  /** null until src/categorize has classified this wallet at least once. */
  category: MerchantCategory | null;
  /** null only for the invalid-address / not-found early-return paths in src/tool.ts. */
  chain: Chain | null;
  /** Every resource (API/service URL) this wallet backs, per the discovery feed — empty array if none ingested yet. Not a scoring input, purely additive context. */
  platforms: MerchantPlatform[];
}

/** One row of db/schema.sql `merchant_signals`, as read back from D1. */
export interface MerchantSignalRow {
  wallet_address: string;
  first_seen_at: number | null;
  wallet_age_days: number | null;
  unique_payer_count: number;
  total_tx_count: number;
  payer_cluster_flag: number;
  completed_flow_count: number;
  abandoned_flow_count: number;
  refund_count: number;
  refund_eligible_volume: number;
  price_variance_flag: number;
  velocity_anomaly_flag: number;
  tier: Tier | null;
  reasons_json: string | null;
  refreshed_at: number;
  /** CAIP-2 network id this row's activity was observed on, e.g. "eip155:8453". */
  network: string;
  /** 'base' | 'solana' — see src/chains.ts. Defaults to 'base' in schema for pre-existing rows. */
  chain: string;
  /** Raw D1 value — validate with isMerchantCategory before trusting as MerchantCategory (see src/tool.ts). */
  category: string | null;
  /** Raw JSON string — parse with JSON.parse before trusting as MerchantPlatform[] (see src/tool.ts). NULL until ingested at least once. */
  platforms_json: string | null;
}
