-- Precomputed merchant-signal store.
-- Written only by the scheduled refresh worker (src/refresh). Read only by
-- the check_merchant tool (src/tool.ts). Never computed live on request.

CREATE TABLE IF NOT EXISTS merchant_signals (
  wallet_address        TEXT PRIMARY KEY,      -- lowercased 0x... address

  -- Signal 1: wallet age / longevity
  first_seen_at         INTEGER,               -- unix seconds of earliest known tx
  wallet_age_days        REAL,

  -- Signal 2: payer diversity
  unique_payer_count     INTEGER DEFAULT 0,
  total_tx_count          INTEGER DEFAULT 0,
  payer_cluster_flag      INTEGER DEFAULT 0,     -- 1 if payers look linked/clustered

  -- Signal 3: settlement completion
  completed_flow_count    INTEGER DEFAULT 0,
  abandoned_flow_count    INTEGER DEFAULT 0,

  -- Signal 4: refunds / recourse
  refund_count            INTEGER DEFAULT 0,
  refund_eligible_volume  INTEGER DEFAULT 0,     -- volume for which a refund path exists on these rails

  -- Signal 5: price consistency
  price_variance_flag     INTEGER DEFAULT 0,     -- 1 if same resource priced differently to different payers

  -- Signal 6: velocity / harness-break anomalies
  -- STUB: no buyer-side wallet-harness pipeline exists yet to reuse (per
  -- 2026-08-10 decision — see README "Signal 6 is stubbed"). This flag is
  -- always 0 until that pipeline exists and this table is backfilled from it.
  velocity_anomaly_flag   INTEGER DEFAULT 0,

  -- Derived output, recomputed each refresh so check_merchant never runs
  -- scoring logic itself beyond formatting — see src/scoring.ts for the
  -- actual composite, this is a cache of its result.
  tier                     TEXT,                  -- 'trusted' | 'caution' | 'avoid'
  reasons_json             TEXT,                  -- JSON array of 1-3 strings

  refreshed_at             INTEGER NOT NULL       -- unix seconds, last aggregation run
);

-- One row per (resource_type, price) quote a merchant has given, used for
-- price-fairness comparison. Populated by the refresh worker from x402
-- payment-required responses observed on-chain/via the facilitator.
CREATE TABLE IF NOT EXISTS price_observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address  TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  price_atomic    INTEGER NOT NULL,
  payer_address   TEXT,
  observed_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_obs_wallet_resource
  ON price_observations (wallet_address, resource_type);

-- Query log for the paid endpoint itself — not a scoring input, just revenue
-- / usage visibility (call volume, which agent frameworks are hitting it —
-- see brief's "Distribution / Go-to-Market").
CREATE TABLE IF NOT EXISTS query_log (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  queried_wallet_address  TEXT NOT NULL,
  payer_address           TEXT,
  tx_hash                 TEXT,
  tier_returned           TEXT,
  queried_at              INTEGER NOT NULL
);
