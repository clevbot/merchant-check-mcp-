import { scoreMerchant } from "../scoring";
import type { Env, MerchantSignalRow } from "../types";
import type { ChainDataSource, RawMerchantActivity } from "./indexer";
import { BazaarDataSource } from "./indexer";
import { PayAIDataSource } from "./solana-indexer";
import { categorizeAndStoreOne } from "../categorize";
import { detectAndNormalize } from "../chains";
import type { Chain } from "../chains";

/**
 * Runs on the cron trigger in wrangler.toml. Pulls raw activity from the
 * ChainDataSource, aggregates it into merchant_signals rows, scores each
 * row, and upserts. check_merchant (src/tool.ts) never runs this logic
 * itself — it only reads the cached result.
 *
 * Categorization (src/categorize) is a deliberately separate concern with
 * its own cadence (see requirement 6 / README "Categorization"), but this
 * loop is the cheapest place to trigger it for a wallet's *first* ingestion:
 * the Bazaar description text is already in hand here, so categorizing
 * inline costs one extra D1 read + write per new wallet, not a second
 * Bazaar crawl. Every wallet already categorized is left untouched —
 * upsertSignals never writes category/category_source/category_updated_at,
 * only bazaar_description (kept fresh every run so a later manual/monthly
 * re-categorization sees current text — see runCategorization).
 */
export async function runRefresh(env: Env): Promise<void> {
  // Base (Bazaar) and Solana (PayAI, optionally Helius-augmented) are two
  // independent ChainDataSource instances, run one after another in the
  // same invocation. They write to the same merchant_signals table
  // distinguished by wallet_address format + the `chain` column (see
  // db/schema.sql) — nothing below needs to know which source a wallet came
  // from beyond that.
  const sources: ChainDataSource[] = [new BazaarDataSource(), new PayAIDataSource(env.HELIUS_API_KEY)];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const sinceSeconds = nowSeconds - 90 * 24 * 60 * 60; // look back 90 days for the active-merchant list

  // D1 caps a Worker invocation at 1000 total queries (paid plan), and each
  // statement inside an env.DB.batch() call still counts individually
  // against that — confirmed empirically (batching didn't dodge it, only
  // fewer total statements did). One D1 call per wallet per concern doesn't
  // scale past a few hundred wallets, so: one bulk category lookup instead
  // of 375 individual SELECTs, and price observations are accumulated in
  // memory across the whole loop (both sources) and written as a handful of
  // bulk statements at the end instead of per wallet — see
  // bulkReplaceCategoryPriceObservations. upsertSignals/upsertPriceObservations
  // stay per-wallet (1 statement each, upsertPriceObservations empty today)
  // since that's exactly the ~1-2/wallet load this pipeline always ran at
  // and is proven to fit comfortably under the cap — adding a second source
  // roughly doubles wallet count, not the cap, so this still holds.
  const existingCategories = await getAllExistingCategories(env);
  const priceRows: { wallet: string; category: string; priceAtomic: number }[] = [];

  // Real, confirmed 2026-08-12 (wrangler tail, live 1101 error): this
  // account's Worker invocation has a hard ~50-subrequest budget, and
  // categorizeAndStoreOne's model-fallback pass (src/categorize/model.ts)
  // is itself one fetch to Anthropic per never-before-seen wallet. Fine
  // when new wallets trickle in a handful at a time (the steady state,
  // after a source's backlog is processed), but Solana's *first* refresh
  // ever can plausibly surface dozens of brand-new wallets in one run —
  // exactly the same class of budget blowout the discovery/Helius fetches
  // above just hit, just via a different call site. Capped here rather
  // than given its own separate budget-tracking mechanism: wallets past
  // the cap simply keep category=null this cycle (an already-handled,
  // normal state elsewhere in this codebase) and get picked up by the
  // existing backlog sweep (runCategorization, POST /categorize) on its
  // own cadence — reusing that machinery instead of duplicating it.
  const MAX_INLINE_CATEGORIZATIONS_PER_RUN = 8;
  let inlineCategorizations = 0;

  for (const source of sources) {
    const wallets = await source.listActiveMerchants(sinceSeconds);

    for (const wallet of wallets) {
      const activity = await source.getMerchantActivity(wallet);
      const row = aggregate(activity, nowSeconds);
      const { tier, reasons } = scoreMerchant(row);
      await upsertSignals(env, { ...row, tier, reasons_json: JSON.stringify(reasons) }, activity.description);
      await upsertPriceObservations(env, row.wallet_address, activity);

      let category = existingCategories.get(row.wallet_address) ?? null;
      if (category === null && inlineCategorizations < MAX_INLINE_CATEGORIZATIONS_PER_RUN) {
        inlineCategorizations++;
        category = (await categorizeAndStoreOne(env, row.wallet_address, activity.description || null)).category;
      }
      if (category) {
        for (const { priceAtomic } of activity.resourcePrices) {
          priceRows.push({ wallet: row.wallet_address, category, priceAtomic });
        }
      }
    }
  }

  await bulkReplaceCategoryPriceObservations(env, priceRows);
}

async function getAllExistingCategories(env: Env): Promise<Map<string, string | null>> {
  const { results } = await env.DB.prepare("SELECT wallet_address, category FROM merchant_signals").all<{
    wallet_address: string;
    category: string | null;
  }>();
  return new Map(results.map((r) => [r.wallet_address, r.category]));
}

function aggregate(
  activity: RawMerchantActivity,
  nowSeconds: number,
  // "category" is excluded here for the same reason "tier"/"reasons_json"
  // are: it's written by a different step (src/categorize), not aggregate/
  // upsertSignals. MerchantSignalRow represents the full D1 row shape for
  // readers like tool.ts; writers Omit whatever columns they don't own.
): Omit<MerchantSignalRow, "tier" | "reasons_json" | "category"> {
  const walletAgeDays =
    activity.firstSeenAt !== null ? (nowSeconds - activity.firstSeenAt) / 86400 : null;

  // Payer-clustering heuristic: placeholder. A real implementation should
  // check whether unique payer wallets share funding sources / were
  // created in a burst / interact only with this merchant — none of which
  // this stub can see. Flags nothing until replaced.
  const payerClusterFlag = 0;

  // Signal 6 (velocity/harness-break anomalies): STUBBED. The brief calls
  // for reusing "the same harness-detection methodology as the buyer-wallet
  // side of Gradient Decisions" — per 2026-08-10 decision, that pipeline
  // doesn't exist yet, so this always reports no anomaly rather than
  // fabricating a heuristic that would silently miscalibrate the tier
  // logic. Replace this function's body once the buyer-side harness
  // detector exists and can be pointed at merchant wallets too.
  const velocityAnomalyFlag = detectVelocityAnomalyStub();

  // Chain is derived from the address's own format (src/chains.ts), not
  // trusted from activity.network — the format is authoritative (0x-hex vs
  // base58 charsets are disjoint) and this stays correct even if a future
  // source mislabels network. Both real sources (BazaarDataSource,
  // PayAIDataSource) only ever emit addresses matching one of the two known
  // formats, so detectAndNormalize succeeding is the expected case; the
  // fallback below only guards against a malformed upstream entry breaking
  // the whole refresh run over one bad row.
  const detected = detectAndNormalize(activity.walletAddress);
  const chain: Chain = detected?.chain ?? (activity.network.startsWith("solana:") ? "solana" : "base");
  const walletAddress = detected?.normalized ?? activity.walletAddress;

  return {
    wallet_address: walletAddress,
    chain,
    network: activity.network,
    first_seen_at: activity.firstSeenAt,
    wallet_age_days: walletAgeDays,
    unique_payer_count: activity.uniquePayerCount,
    total_tx_count: activity.txCount,
    payer_cluster_flag: payerClusterFlag,
    completed_flow_count: activity.completedFlows,
    abandoned_flow_count: activity.abandonedFlows,
    refund_count: activity.refunds,
    refund_eligible_volume: activity.refundEligibleVolume,
    price_variance_flag: computePriceVarianceFlag(activity),
    velocity_anomaly_flag: velocityAnomalyFlag,
    refreshed_at: nowSeconds,
    platforms_json: activity.platforms.length > 0 ? JSON.stringify(activity.platforms) : null,
  };
}

function detectVelocityAnomalyStub(): number {
  return 0;
}

// Currently always evaluates to 0 for Bazaar-sourced activity —
// BazaarDataSource never populates priceObservations (see indexer.ts class
// comment for why). Kept as real logic, not deleted, so it activates for
// free once a source that can populate priceObservations exists.
function computePriceVarianceFlag(activity: RawMerchantActivity): number {
  const byResource = new Map<string, Set<number>>();
  for (const obs of activity.priceObservations) {
    const set = byResource.get(obs.resourceType) ?? new Set<number>();
    set.add(obs.priceAtomic);
    byResource.set(obs.resourceType, set);
  }
  for (const prices of byResource.values()) {
    if (prices.size > 1) return 1;
  }
  return 0;
}

async function upsertSignals(
  env: Env,
  row: Omit<MerchantSignalRow, "category">,
  bazaarDescription: string,
): Promise<void> {
  // Deliberately does NOT write category / category_source /
  // category_updated_at, in either the INSERT column list or the ON
  // CONFLICT UPDATE SET — those are src/categorize's to write, on its own
  // cadence. bazaar_description IS written/refreshed here every run (see
  // module comment) so categorization always has current text when it does
  // run, without needing its own Bazaar fetch.
  await env.DB.prepare(
    `INSERT INTO merchant_signals (
      wallet_address, chain, network, first_seen_at, wallet_age_days, unique_payer_count, total_tx_count,
      payer_cluster_flag, completed_flow_count, abandoned_flow_count, refund_count,
      refund_eligible_volume, price_variance_flag, velocity_anomaly_flag, tier, reasons_json,
      refreshed_at, bazaar_description, platforms_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address) DO UPDATE SET
      chain = excluded.chain,
      network = excluded.network,
      first_seen_at = excluded.first_seen_at,
      wallet_age_days = excluded.wallet_age_days,
      unique_payer_count = excluded.unique_payer_count,
      total_tx_count = excluded.total_tx_count,
      payer_cluster_flag = excluded.payer_cluster_flag,
      completed_flow_count = excluded.completed_flow_count,
      abandoned_flow_count = excluded.abandoned_flow_count,
      refund_count = excluded.refund_count,
      refund_eligible_volume = excluded.refund_eligible_volume,
      price_variance_flag = excluded.price_variance_flag,
      velocity_anomaly_flag = excluded.velocity_anomaly_flag,
      tier = excluded.tier,
      reasons_json = excluded.reasons_json,
      refreshed_at = excluded.refreshed_at,
      bazaar_description = excluded.bazaar_description,
      platforms_json = excluded.platforms_json`,
  )
    .bind(
      row.wallet_address,
      row.chain,
      row.network,
      row.first_seen_at,
      row.wallet_age_days,
      row.unique_payer_count,
      row.total_tx_count,
      row.payer_cluster_flag,
      row.completed_flow_count,
      row.abandoned_flow_count,
      row.refund_count,
      row.refund_eligible_volume,
      row.price_variance_flag,
      row.velocity_anomaly_flag,
      row.tier,
      row.reasons_json,
      row.refreshed_at,
      bazaarDescription || null,
      row.platforms_json,
    )
    .run();
}

async function upsertPriceObservations(
  env: Env,
  wallet: string, // already chain-normalized by the caller (aggregate()'s row.wallet_address) — do not re-lowercase here, that would corrupt Solana addresses.
  activity: RawMerchantActivity,
): Promise<void> {
  for (const obs of activity.priceObservations) {
    await env.DB.prepare(
      `INSERT INTO price_observations (wallet_address, resource_type, price_atomic, payer_address, observed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(wallet, obs.resourceType, obs.priceAtomic, obs.payer, obs.at)
      .run();
  }
}

/**
 * Cross-merchant price-fairness data (db/queries.ts getComparablePrices,
 * src/tool.ts) for every wallet processed this run, written in one bulk
 * pass rather than per wallet. resource_type holds each row's wallet's own
 * `category`; payer_address is always NULL — that NULL is the marker
 * distinguishing a category-snapshot row (this function) from a true
 * per-payer observation row (upsertPriceObservations, currently always
 * empty — see indexer.ts).
 *
 * History: the first two versions of this function did the delete+insert
 * per wallet (optionally batched). Both failed against production, caught
 * via a live wrangler tail session, not by inspection: individual
 * statements per wallet hit D1's 1000-queries-per-invocation cap
 * ("Too many API requests by single Worker invocation") across ~375
 * wallets; batching per wallet didn't help, because each statement inside
 * an env.DB.batch() call still counts individually against that cap — only
 * *fewer total statements* does. This version deletes every snapshot row
 * once (not once per wallet — everyone gets fresh rows this same run
 * anyway) and inserts everyone's rows in ~20-100 chunked statements total,
 * regardless of how many wallets or resources are involved.
 */
async function bulkReplaceCategoryPriceObservations(
  env: Env,
  rows: { wallet: string; category: string; priceAtomic: number }[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM price_observations WHERE payer_address IS NULL").run();
  if (rows.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  // D1's actual bound-parameter limit is ~100 per statement — not standard
  // SQLite's 999, and not documented in D1's own error message (just
  // "too many SQL variables at offset N", found the real number via
  // real-world bug reports after two earlier chunk sizes both failed at a
  // suspiciously identical offset regardless of chunk size, which in
  // hindsight was because those attempts wrapped multiple statements in one
  // env.DB.batch() call — the ~100 limit seems to apply to the combined
  // params across a whole batch, not just one statement within it. This
  // version issues one INSERT per chunk as an independent statement (no
  // batch()), so 20 rows * 4 params/row = 80 stays safely under 100. With
  // ~1,950 total rows across ~370 wallets that's ~100 INSERT statements —
  // still trivial against the 1000-queries-per-invocation cap alongside
  // the ~370 upsertSignals calls in the same run.
  const CHUNK_SIZE = 20;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?, NULL, ?)").join(", ");
    await env.DB.prepare(
      `INSERT INTO price_observations (wallet_address, resource_type, price_atomic, payer_address, observed_at)
       VALUES ${placeholders}`,
    )
      .bind(...chunk.flatMap(({ wallet, category, priceAtomic }) => [wallet, category, priceAtomic, now]))
      .run();
  }
}
