export interface Env {
  DB: D1Database;
  /** CAIP-2 format, e.g. "eip155:84532" (Base Sepolia) or "eip155:8453" (Base mainnet). */
  X402_NETWORK: string;
  X402_FACILITATOR_URL: string;
  /** Set via `wrangler secret put PAYOUT_ADDRESS` — see README "Before this can run". */
  PAYOUT_ADDRESS: string;
  /** Optional — only needed once CdpDataApiSource (src/refresh/indexer.ts) is implemented. */
  CDP_API_KEY?: string;
}

export type Tier = "trusted" | "caution" | "avoid";
export type PriceFairness = "fair" | "high" | "low" | "unknown";

export interface CheckMerchantInput {
  merchant_wallet_address: string;
  price?: number;
  resource_type?: string;
}

export interface CheckMerchantOutput {
  tier: Tier;
  reasons: string[];
  price_fairness: PriceFairness;
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
}
