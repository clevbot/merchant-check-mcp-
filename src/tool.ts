import { scoreMerchant, scorePriceFairness } from "./scoring";
import { getComparablePrices, getMerchantSignals, isValidWalletAddress } from "./db/queries";
import { isMerchantCategory } from "./categorize/types";
import type { CheckMerchantInput, CheckMerchantOutput, Env } from "./types";

/**
 * Core check_merchant logic. Reads only from the precomputed D1 store — no
 * chain access here, that's the whole point of the refresh-worker split
 * (see src/refresh). Keeps this handler fast enough to run inside a paid,
 * per-request Worker invocation.
 */
export async function checkMerchant(
  env: Env,
  input: CheckMerchantInput,
): Promise<CheckMerchantOutput> {
  if (!isValidWalletAddress(input.merchant_wallet_address)) {
    return {
      tier: "caution",
      reasons: ["merchant_wallet_address is not a valid EVM address — cannot score"],
      price_fairness: "unknown",
      category: null,
    };
  }

  const row = await getMerchantSignals(env, input.merchant_wallet_address);

  if (!row) {
    return {
      tier: "caution",
      reasons: ["No transaction history found for this wallet on indexed rails"],
      price_fairness: "unknown",
      category: null,
    };
  }

  const { tier, reasons } = scoreMerchant(row);
  const category = row.category && isMerchantCategory(row.category) ? row.category : null;

  // Price-fairness compares against the merchant's own `category`, not the
  // caller-supplied resource_type (kept in the input schema for backward
  // compatibility, but no longer required or used here) — category is the
  // only bucket real Bazaar-sourced price data actually exists for. See
  // src/refresh/index.ts upsertCategoryPriceObservations.
  let priceFairness: CheckMerchantOutput["price_fairness"] = "unknown";
  if (input.price !== undefined && category) {
    const comparable = await getComparablePrices(env, category, input.merchant_wallet_address);
    // price is USD-equivalent float from the caller; store/compare in atomic
    // USDC units (6 decimals) to match price_observations.
    const requestedAtomic = Math.round(input.price * 1_000_000);
    priceFairness = scorePriceFairness(requestedAtomic, comparable);
  }

  return { tier, reasons, price_fairness: priceFairness, category };
}
