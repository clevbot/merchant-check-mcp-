export interface Env {
  DB: D1Database;
  /** CAIP-2 format, e.g. "eip155:84532" (Base Sepolia) or "eip155:8453" (Base mainnet). */
  X402_NETWORK: string;
  X402_FACILITATOR_URL: string;
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
}

import type { MerchantCategory } from "./categorize/types";

export type Tier = "trusted" | "caution" | "avoid";
export type PriceFairness = "fair" | "high" | "low" | "unknown";

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
}

export interface CheckMerchantOutput {
  tier: Tier;
  reasons: string[];
  price_fairness: PriceFairness;
  /** null until src/categorize has classified this wallet at least once. */
  category: MerchantCategory | null;
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
  /** Raw D1 value — validate with isMerchantCategory before trusting as MerchantCategory (see src/tool.ts). */
  category: string | null;
}
