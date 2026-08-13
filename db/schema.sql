-- Precomputed merchant-signal store.
-- Written only by the scheduled refresh worker (src/refresh). Read only by
-- the check_merchant tool (src/tool.ts). Never computed live on request.

CREATE TABLE IF NOT EXISTS merchant_signals (
  -- Base addresses are lowercased 0x-hex; Solana addresses are base58 and
  -- kept exactly as given (base58 is case-sensitive — see src/chains.ts,
  -- which every write/read of this column must go through). wallet_address
  -- alone is safe as a sole PRIMARY KEY across both chains: the two address
  -- formats (0x-hex vs base58) are disjoint character sets, so there's no
  -- realistic collision even without a composite (chain, wallet_address) key.
  wallet_address        TEXT PRIMARY KEY,
  -- 'base' | 'solana'. Added 2026-08-12; existing rows default to 'base'
  -- since every prior write was Base-only.
  chain                  TEXT NOT NULL DEFAULT 'base',

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
  -- FLAGGED (2026-08-12): when this does get implemented, it should NOT
  -- reuse Base-tuned velocity thresholds unmodified for chain='solana' rows.
  -- Solana finality is roughly 4x faster than Base's (~0.5s vs ~2s), so
  -- transaction-frequency patterns that would look anomalous on Base could
  -- be entirely normal Solana activity, purely from chain speed, not
  -- genuine behavior difference — see README "Solana signal caveats".
  velocity_anomaly_flag   INTEGER DEFAULT 0,

  -- Derived output, recomputed each refresh so check_merchant never runs
  -- scoring logic itself beyond formatting — see src/scoring.ts for the
  -- actual composite, this is a cache of its result.
  tier                     TEXT,                  -- 'trusted' | 'caution' | 'avoid'
  reasons_json             TEXT,                  -- JSON array of 1-3 strings

  refreshed_at             INTEGER NOT NULL,      -- unix seconds, last aggregation run

  -- 1 for the two synthetic rows seeded for scripts/demo-client.ts (see
  -- README "Demo data"). Real refresh-worker writes (BazaarDataSource)
  -- never set this. Excluded from the public dashboard/API
  -- (src/dashboard.ts) so gradientdecisions.com never shows fake data
  -- alongside real merchants; still visible to check_merchant itself so the
  -- demo script keeps working.
  is_demo                  INTEGER NOT NULL DEFAULT 0,

  -- CAIP-2 network id this row's activity was observed on. Distinct from
  -- is_demo: is_demo marks *fake* rows, network marks *which chain real
  -- rows came from*. Currently always eip155:8453 (Base mainnet) for real
  -- BazaarDataSource writes — it only ever ingests mainnet payTo addresses
  -- (see indexer.ts BASE_MAINNET_NETWORK). The two is_demo=1 rows are tagged
  -- eip155:84532 (Base Sepolia), matching the network the demo/test payment
  -- flow actually runs on. Once test-network activity can appear in a real
  -- data source (not just synthetic demo rows), filter on this rather than
  -- is_demo to keep it out of the public dataset.
  network                   TEXT NOT NULL DEFAULT 'eip155:8453',

  -- Merchant categorization — additive, does not feed src/scoring.ts.
  -- Raw text captured from the Bazaar listing every trust-signal refresh
  -- (so it's always current even though categorization itself runs on a
  -- separate, much slower cadence — see src/categorize). Concatenation of
  -- every resource's description this wallet backs; NULL for is_demo rows
  -- (they don't come from Bazaar) and for anything not yet ingested.
  bazaar_description        TEXT,

  -- One of the six fixed values in src/categorize/types.ts. NULL until the
  -- categorization pass (not the trust-signal refresh) has run for this
  -- wallet at least once. Never invented outside the fixed set — anything
  -- the rule+model pipeline can't confidently place lands in 'other' and is
  -- logged to category_review_log below, not given a new category.
  category                  TEXT,
  -- 'rule' | 'model' — which pass produced the current `category` value.
  category_source           TEXT,
  -- unix seconds of the last categorization run for this wallet. Separate
  -- from `refreshed_at` on purpose: refreshed_at moves every 4h with trust
  -- signals, category_updated_at only moves when src/categorize actually
  -- runs (first ingestion, or a manual/monthly force re-run).
  category_updated_at       INTEGER,

  -- Added 2026-08-12. JSON array of {url, serviceName} — every distinct
  -- resource (API/service endpoint) this wallet backs, straight from the
  -- discovery feed's own `resource` + `serviceName` fields (real data both
  -- Bazaar and PayAI already return per listing; previously only ever
  -- blended into bazaar_description's text blob and discarded structured).
  -- One wallet can back multiple resources, hence an array not a single
  -- URL. NULL for is_demo rows and anything not yet ingested, same as
  -- bazaar_description. Not a scoring input — purely additive context for
  -- check_merchant callers and the dashboard, same status as `category`.
  platforms_json             TEXT
);

-- Spot-check log for categorization decisions worth a human look: every
-- pass-2 (model) classification, per the brief's own logging requirement,
-- plus every 'other' bucket assignment regardless of which pass produced
-- it (rule pass found nothing AND model pass unavailable/unparseable is
-- exactly the case requirement 2 asks to flag rather than silently accept).
CREATE TABLE IF NOT EXISTS category_review_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address    TEXT NOT NULL,
  description_text  TEXT,
  category           TEXT NOT NULL,
  category_source    TEXT NOT NULL,
  -- 'model_classified' | 'other_no_rule_match' | 'other_model_unavailable' | 'other_unparseable_model_output'
  reason              TEXT NOT NULL,
  raw_model_output    TEXT,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_category_review_created
  ON category_review_log (created_at DESC);

-- One row per (resource_type, price) quote a merchant has given, used for
-- price-fairness comparison (src/tool.ts, db/queries.ts getComparablePrices).
-- Two distinct kinds of row share this table, told apart by payer_address:
--   - payer_address IS NULL: a category-snapshot row (src/refresh/index.ts
--     upsertCategoryPriceObservations). resource_type holds the wallet's
--     own src/categorize `category` (data_api, compute, ...), price_atomic
--     is that resource's currently-advertised price from Bazaar. Replaced
--     wholesale every refresh cycle (old rows for a wallet are deleted
--     before new ones are inserted) — always a current snapshot, not a
--     history. This is what price_fairness actually compares against today.
--   - payer_address IS NOT NULL: a true per-payer observation — what a
--     *specific* payer was actually quoted, for signal 5 (price
--     discrimination) in src/scoring.ts. Nothing currently writes these;
--     BazaarDataSource has no visibility into per-payer pricing, only the
--     single currently-advertised price. Reserved for a future indexer
--     that can see real quote-level data.
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
-- see brief's "Distribution / Go-to-Market") and, since 2026-08-12, the
-- observability data for the pre-payment-primitive adoption hypothesis
-- (see README "Observability" / src/index.ts getMetricsSummary).
CREATE TABLE IF NOT EXISTS query_log (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  queried_wallet_address  TEXT NOT NULL,
  payer_address           TEXT,
  tx_hash                 TEXT,
  -- Historical placeholder column: every row before 2026-08-12 has the
  -- literal string "settled" here, not a real tier — onAfterSettlement
  -- (src/index.ts) didn't have access to the tool handler's return value
  -- at the time. Fixed 2026-08-12 via a closure-captured result (see
  -- src/index.ts createServer) — rows from that point on carry the real
  -- trust_tier. Column kept (not renamed) for continuity; `recommendation`
  -- below is the new, complete field and what getMetricsSummary reads.
  tier_returned           TEXT,
  -- Added 2026-08-12. 'PROCEED' | 'CAUTION' | 'INSUFFICIENT_SIGNAL' | NULL
  -- (NULL only for rows logged before this column existed).
  recommendation          TEXT,
  -- Added 2026-08-12. Wall-clock ms from request start to settlement,
  -- captured in src/index.ts. NULL for pre-existing rows.
  latency_ms              INTEGER,
  -- Added 2026-08-13, for the internal caller-tracking dashboard (see
  -- src/callerDashboard.ts). queried_category is the *checked merchant's*
  -- category from the response (not caller-supplied — there's no category
  -- input field), included so "what kinds of merchants are being checked"
  -- is queryable without joining back to merchant_signals, which can drift
  -- (a merchant's category can be recategorized after the query happened).
  -- caller_supplied_price_atomic is genuinely caller-supplied: input.price
  -- converted to atomic units, NULL if the caller didn't pass one.
  queried_category          TEXT,
  caller_supplied_price_atomic INTEGER,
  queried_at              INTEGER NOT NULL
);
