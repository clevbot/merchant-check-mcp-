/**
 * On-chain / x402-ecosystem data source abstraction for the refresh worker.
 *
 * Decision (2026-08-10, revised same day): the original plan here was
 * Coinbase's CDP wallet-history API, which needs a CDP account + API key —
 * account creation isn't something Claude does on your behalf, so that
 * stayed a stub. Investigating further turned up a better fit for v1: the
 * **x402 Bazaar**, Coinbase's own facilitator discovery catalog
 * (https://docs.cdp.coinbase.com/x402/bazaar). It's public, needs no
 * account or key, and already aggregates real per-merchant quality metrics
 * (30-day call volume, unique payers) — directly useful for signals 2 and 3
 * without building a custom chain indexer.
 *
 * Real scope limits, so the gaps are honest rather than silently wrong:
 * - Only covers merchants who've *registered* a resource on Bazaar, not
 *   every wallet that's ever received an x402 payment.
 * - No first-activity timestamp -> wallet_age_days stays null for every
 *   Bazaar-sourced row (signal 1 unmeasured, not fabricated as "not new").
 * - No settlement completion/abandonment or refund visibility from a
 *   directory listing -> signals 3 (partially) and 4 stay at 0, meaning
 *   scoreMerchant() can't flag either for Bazaar-sourced rows.
 * - Bazaar's "resource" is an API endpoint (e.g. a weather API), which
 *   doesn't map to the caller-supplied `resource_type` buckets check_merchant
 *   uses for price-fairness (that's about goods/services categories, not API
 *   call types) -> priceObservations stays empty from this source.
 *
 * Filling those gaps needs either the CDP wallet-history API (account
 * required — see README "Data source") or a custom chain indexer. Both are
 * future work, not blocked on anything here.
 */

const BAZAAR_DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
/** Exported so other modules (e.g. src/dashboard.ts) filter on the same value rather than a second hardcoded copy. */
export const BASE_MAINNET_NETWORK = "eip155:8453";
const PAGE_SIZE = 100;
// 20 pages * 100 = up to 2,000 resources per refresh run. Bazaar had ~14.5k
// total resources as of 2026-08-10; raise this once refresh-worker runtime/
// cost at full coverage is known. Cheaper than it sounds since this is a
// single unauthenticated fetch loop, not per-wallet chain calls.
const MAX_PAGES = 20;

export interface RawMerchantActivity {
  walletAddress: string;
  /** CAIP-2 network id this activity was observed on, e.g. "eip155:8453". */
  network: string;
  firstSeenAt: number | null; // unix seconds
  txCount: number;
  uniquePayerCount: number;
  completedFlows: number;
  abandonedFlows: number;
  refunds: number;
  refundEligibleVolume: number;
  priceObservations: { resourceType: string; priceAtomic: number; payer: string; at: number }[];
  /**
   * Concatenation of every resource description this wallet backs — the raw
   * text src/categorize classifies from. Empty string if Bazaar gave no
   * description for any of them (categorization still runs on empty text,
   * lands in 'other', gets flagged — see categorizeDescription).
   */
  description: string;
}

export interface ChainDataSource {
  /** All merchant wallets with x402 activity since `sinceUnixSeconds`. */
  listActiveMerchants(sinceUnixSeconds: number): Promise<string[]>;
  getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity>;
}

interface BazaarAccept {
  network: string;
  payTo: string;
}
interface BazaarItem {
  resource: string;
  accepts: BazaarAccept[];
  quality?: { l30DaysTotalCalls?: number; l30DaysUniquePayers?: number };
  description?: string;
  serviceName?: string;
  tags?: string[];
}
interface BazaarListResponse {
  items: BazaarItem[];
  pagination: { limit: number; offset: number; total: number };
}

export class BazaarDataSource implements ChainDataSource {
  // Populated by listActiveMerchants(); getMerchantActivity() reads from
  // this rather than re-fetching. runRefresh() (src/refresh/index.ts) always
  // calls listActiveMerchants() once before looping getMerchantActivity()
  // calls on the same instance, so the cache is warm by the time it's read.
  private cache = new Map<string, RawMerchantActivity>();

  async listActiveMerchants(_sinceUnixSeconds: number): Promise<string[]> {
    this.cache.clear();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${BAZAAR_DISCOVERY_URL}?limit=${PAGE_SIZE}&offset=${offset}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Bazaar discovery request failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as BazaarListResponse;
      for (const item of body.items) {
        this.ingestItem(item);
      }
      offset += PAGE_SIZE;
      if (offset >= body.pagination.total || body.items.length === 0) break;
    }
    return [...this.cache.keys()];
  }

  async getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity> {
    const activity = this.cache.get(walletAddress.toLowerCase());
    if (!activity) {
      throw new Error(
        `No cached Bazaar activity for ${walletAddress} — listActiveMerchants() must run ` +
          `first on this same BazaarDataSource instance.`,
      );
    }
    return activity;
  }

  private ingestItem(item: BazaarItem): void {
    // A resource can list multiple payment *schemes* (e.g. "exact" and
    // "batch-settlement") that share the same payTo — dedupe to unique
    // Base-mainnet payTo addresses so a resource's call volume isn't
    // double-counted per scheme option.
    const basePayTos = new Set(
      (item.accepts ?? [])
        .filter((a) => a.network === BASE_MAINNET_NETWORK && a.payTo)
        .map((a) => a.payTo.toLowerCase()),
    );
    const calls = item.quality?.l30DaysTotalCalls ?? 0;
    const payers = item.quality?.l30DaysUniquePayers ?? 0;
    const descriptionPart = [item.serviceName, item.description, ...(item.tags ?? [])]
      .filter(Boolean)
      .join(". ");

    for (const wallet of basePayTos) {
      const existing = this.cache.get(wallet);
      if (existing) {
        // One merchant wallet can back multiple resources (e.g. several API
        // endpoints) — sum call volume across them. uniquePayerCount takes
        // the max seen on any single resource as a floor: a true union
        // would need actual payer identities, which Bazaar's directory
        // listing doesn't expose, only per-resource counts. Descriptions
        // concatenate — categorization sees everything this wallet sells.
        existing.txCount += calls;
        existing.uniquePayerCount = Math.max(existing.uniquePayerCount, payers);
        if (descriptionPart) {
          existing.description = existing.description
            ? `${existing.description}. ${descriptionPart}`
            : descriptionPart;
        }
      } else {
        this.cache.set(wallet, {
          walletAddress: wallet,
          network: BASE_MAINNET_NETWORK,
          firstSeenAt: null,
          txCount: calls,
          uniquePayerCount: payers,
          completedFlows: 0,
          abandonedFlows: 0,
          refunds: 0,
          refundEligibleVolume: 0,
          priceObservations: [],
          description: descriptionPart,
        });
      }
    }
  }
}

/** In-memory fixture source, useful for local dev/backtest without live chain access. */
export class FixtureDataSource implements ChainDataSource {
  constructor(private readonly fixtures: Record<string, RawMerchantActivity>) {}

  async listActiveMerchants(): Promise<string[]> {
    return Object.keys(this.fixtures);
  }

  async getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity> {
    const fixture = this.fixtures[walletAddress.toLowerCase()];
    if (!fixture) throw new Error(`No fixture for ${walletAddress}`);
    return fixture;
  }
}
