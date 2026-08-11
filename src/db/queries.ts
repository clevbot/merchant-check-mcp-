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

// TODO(price-fairness-by-category): once price_observations has real volume
// (currently always empty — see src/refresh/indexer.ts BazaarDataSource
// class comment), join against merchant_signals.category here and filter
// comparable prices to the same category as the merchant being scored,
// not the whole dataset. merchant_signals.category is populated and
// queryable now (see src/categorize) specifically so this join is ready to
// write whenever price_observations has data to join against. Deliberately
// not wired up yet — no real price data exists to validate it against.
export async function getComparablePrices(
  env: Env,
  resourceType: string,
  excludeWallet: string,
): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT price_atomic FROM price_observations
     WHERE resource_type = ? AND wallet_address != ?
     ORDER BY observed_at DESC LIMIT 200`,
  )
    .bind(resourceType, excludeWallet.toLowerCase())
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
