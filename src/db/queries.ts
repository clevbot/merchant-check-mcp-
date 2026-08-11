import type { Env, MerchantSignalRow } from "../types";

/** Basic shape check — full validation happens on-chain, this just guards D1/input. */
export function isValidWalletAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

export async function getMerchantSignals(
  env: Env,
  walletAddress: string,
): Promise<MerchantSignalRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM merchant_signals WHERE wallet_address = ?",
  )
    .bind(walletAddress.toLowerCase())
    .first<MerchantSignalRow>();
  return row ?? null;
}

/**
 * Comparable prices for price-fairness (src/tool.ts). `category` is the
 * merchant's own src/categorize category, not a caller-supplied string —
 * price_observations.resource_type holds category values written by
 * src/refresh/index.ts upsertCategoryPriceObservations (payer_address IS
 * NULL rows specifically; see db/schema.sql for the other kind of row this
 * table can hold). Implemented 2026-08-11 once category gave this function
 * an actual bucket to compare within — previously always returned "unknown"
 * since nothing populated price_observations at all.
 *
 * ORDER BY RANDOM() rather than ORDER BY observed_at DESC: every row from a
 * given bulk refresh shares the exact same observed_at (they're all written
 * in one pass — see upsertCategoryPriceObservations), so sorting by it isn't
 * sorting by anything at all with a fully-tied key, and LIMIT then returns
 * some arbitrary but *not* representative subset of rows. Caught this live:
 * a real merchant priced far below its category's true median still came
 * back price_fairness "high", because the LIMIT 200 subset it happened to
 * compare against was itself skewed low. A random sample is representative
 * regardless of how many rows share a timestamp, and stays correct even
 * once refresh timing gives observed_at genuine spread in the future.
 */
export async function getComparablePrices(
  env: Env,
  category: string,
  excludeWallet: string,
): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT price_atomic FROM price_observations
     WHERE resource_type = ? AND wallet_address != ? AND payer_address IS NULL
     ORDER BY RANDOM() LIMIT 200`,
  )
    .bind(category, excludeWallet.toLowerCase())
    .all<{ price_atomic: number }>();
  return results.map((r) => r.price_atomic);
}

export async function logQuery(
  env: Env,
  queriedWallet: string,
  payerAddress: string | null,
  txHash: string | null,
  tierReturned: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO query_log (queried_wallet_address, payer_address, tx_hash, tier_returned, queried_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(queriedWallet.toLowerCase(), payerAddress, txHash, tierReturned, Math.floor(Date.now() / 1000))
    .run();
}
