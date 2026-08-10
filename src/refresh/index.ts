import { scoreMerchant } from "../scoring";
import type { Env, MerchantSignalRow } from "../types";
import type { ChainDataSource, RawMerchantActivity } from "./indexer";
import { BazaarDataSource } from "./indexer";

/**
 * Runs on the cron trigger in wrangler.toml. Pulls raw activity from the
 * ChainDataSource, aggregates it into merchant_signals rows, scores each
 * row, and upserts. check_merchant (src/tool.ts) never runs this logic
 * itself — it only reads the cached result.
 */
export async function runRefresh(env: Env): Promise<void> {
  const source: ChainDataSource = getDataSource(env);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const sinceSeconds = nowSeconds - 90 * 24 * 60 * 60; // look back 90 days for the active-merchant list

  const wallets = await source.listActiveMerchants(sinceSeconds);

  for (const wallet of wallets) {
    const activity = await source.getMerchantActivity(wallet);
    const row = aggregate(activity, nowSeconds);
    const { tier, reasons } = scoreMerchant(row);
    await upsertSignals(env, { ...row, tier, reasons_json: JSON.stringify(reasons) });
    await upsertPriceObservations(env, wallet, activity);
  }
}

function getDataSource(_env: Env): ChainDataSource {
  // Public, no-key x402 Bazaar discovery catalog — see indexer.ts for scope
  // and limitations (real data, but only for Bazaar-registered merchants).
  return new BazaarDataSource();
}

function aggregate(
  activity: RawMerchantActivity,
  nowSeconds: number,
): Omit<MerchantSignalRow, "tier" | "reasons_json"> {
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

  return {
    wallet_address: activity.walletAddress.toLowerCase(),
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
  row: MerchantSignalRow,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO merchant_signals (
      wallet_address, network, first_seen_at, wallet_age_days, unique_payer_count, total_tx_count,
      payer_cluster_flag, completed_flow_count, abandoned_flow_count, refund_count,
      refund_eligible_volume, price_variance_flag, velocity_anomaly_flag, tier, reasons_json, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address) DO UPDATE SET
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
      refreshed_at = excluded.refreshed_at`,
  )
    .bind(
      row.wallet_address,
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
    )
    .run();
}

async function upsertPriceObservations(
  env: Env,
  wallet: string,
  activity: RawMerchantActivity,
): Promise<void> {
  for (const obs of activity.priceObservations) {
    await env.DB.prepare(
      `INSERT INTO price_observations (wallet_address, resource_type, price_atomic, payer_address, observed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(wallet.toLowerCase(), obs.resourceType, obs.priceAtomic, obs.payer, obs.at)
      .run();
  }
}
