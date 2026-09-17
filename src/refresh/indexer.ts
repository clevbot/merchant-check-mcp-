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
 *   doesn't map to a caller-supplied goods/services resource_type ->
 *   priceObservations (the true per-payer signal-5 field) stays empty from
 *   this source; there's no way to tell if a specific payer was quoted a
 *   different price than another. What Bazaar *does* give us is each
 *   resource's single currently-advertised price — see resourcePrices
 *   below, populated since 2026-08-11 and used for cross-merchant
 *   price-fairness comparison keyed by src/categorize's `category` instead
 *   (see src/refresh/index.ts upsertCategoryPriceObservations).
 *
 * Filling the remaining gaps (signal 1 wallet age, signals 3/4 settlement/
 * refund visibility, true per-payer price variance for signal 5) needs
 * either the CDP wallet-history API (account required — see README "Data
 * source") or a custom chain indexer. Both future work, not blocked on
 * anything here.
 */

const BAZAAR_DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
/** Exported so other modules (e.g. src/dashboard.ts) filter on the same value rather than a second hardcoded copy. */
export const BASE_MAINNET_NETWORK = "eip155:8453";
const PAGE_SIZE = 100;
// 20 pages * 100 = up to 2,000 resources scanned per refresh run — not the
// same as 2,000 resources total anymore (see listActiveMerchants' rotation
// comment, added 2026-09-17): each run's 2,000-item window now rotates
// through the whole catalog over successive cycles instead of always being
// the same first 2,000. Bazaar had ~14.5k total resources as of 2026-08-10,
// ~15.9k as of 2026-09-17; raise this once refresh-worker runtime/cost at a
// wider per-run slice is known. Cheaper than it sounds since this is a
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
  /**
   * Each Base-mainnet resource this wallet backs, with its currently
   * advertised price in atomic USDC units (6 decimals). Used for
   * cross-merchant price-fairness comparison, bucketed by category — not
   * the same thing as priceObservations above (which is per-*payer*
   * variation for the same resource; this is per-*resource* snapshot,
   * refreshed every cycle, no payer identity attached).
   */
  resourcePrices: { resource: string; priceAtomic: number }[];
  /**
   * Every distinct resource (API/service URL) this wallet backs, with its
   * listed name if the discovery feed gave one. This is real data both
   * Bazaar and PayAI already return per listing (the `resource` and
   * `serviceName` fields) — previously only ever blended into the
   * `description` text blob above and never surfaced structured. One
   * wallet can back multiple resources (e.g. several API endpoints), so
   * this is a list, not a single URL — dedupe by URL, same pattern as
   * resourcePrices.
   */
  platforms: { url: string; serviceName: string | null }[];
}

export interface ChainDataSource {
  /** All merchant wallets with x402 activity since `sinceUnixSeconds`. */
  listActiveMerchants(sinceUnixSeconds: number): Promise<string[]>;
  getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity>;
}

interface BazaarAccept {
  network: string;
  payTo: string;
  scheme?: string;
  amount?: string;
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

    // Page 0 is always scanned fresh (cheap, and gives pagination.total —
    // we don't know the real catalog size ahead of time).
    const firstRes = await fetch(`${BAZAAR_DISCOVERY_URL}?limit=${PAGE_SIZE}&offset=0`, {
      headers: { Accept: "application/json" },
    });
    if (!firstRes.ok) {
      throw new Error(`Bazaar discovery request failed: ${firstRes.status} ${firstRes.statusText}`);
    }
    const firstBody = (await firstRes.json()) as BazaarListResponse;
    for (const item of firstBody.items) {
      this.ingestItem(item);
    }
    const total = firstBody.pagination.total;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Rotate which of the REMAINING (MAX_PAGES - 1) pages get scanned each
    // cycle — added 2026-09-17 after a real, confirmed finding (same
    // pattern src/refresh/solana-indexer.ts's PayAIDataSource already fixed
    // for the identical reason 2026-08-18): this always started at offset 0
    // and scanned the same fixed MAX_PAGES window every single cycle,
    // forever. Confirmed live: Bazaar's Base catalog had grown to ~15,875
    // resources while this indexer had never scanned past position 2,000,
    // and 2,000 raw resource listings collapse to only ~542 distinct payTo
    // wallets (merchants commonly back several resource routes each) — this
    // indexer's own merchant_signals count (695) lines up almost exactly
    // with that fixed window's unique-wallet count, not coincidentally.
    // Now every cycle covers a different slice, so new merchants keep
    // surfacing over time instead of the same ~540 forever. Same caveat as
    // the Solana version: this fixes staleness/repetition, it does not make
    // a full sweep of a growing ~16k-item catalog instant — at MAX_PAGES
    // pages/cycle on a 2h cadence, a full sweep still takes days to weeks.
    const remainingPageBudget = MAX_PAGES - 1;
    const rotatablePages = Math.max(1, totalPages - 1); // excludes page 0, already covered above
    const cycleSeconds = 2 * 60 * 60; // matches wrangler.toml's refresh cron cadence
    const epoch = Math.floor(Date.now() / 1000 / cycleSeconds);
    const startIndex = epoch % rotatablePages;

    for (let i = 0; i < remainingPageBudget; i++) {
      const pageNum = 1 + ((startIndex + i) % rotatablePages);
      const offset = pageNum * PAGE_SIZE;
      if (offset >= total) continue;
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
    }
    return [...this.cache.keys()];
  }

  async getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity> {
    const activity = this.cache.get(walletAddress.toLowerCase());
    if (!activity) {
      throw new Error(
        `No cached Bazaar activity for ${walletAddress}. listActiveMerchants() must run ` +
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

    // One canonical price per resource: prefer the "exact" scheme (the one
    // check_merchant's own payment flow uses) if the resource offers it,
    // else whatever Base-mainnet option comes first. A resource with no
    // parseable amount contributes nothing here rather than a bogus 0.
    const baseAccepts = (item.accepts ?? []).filter((a) => a.network === BASE_MAINNET_NETWORK && a.amount);
    const chosenAccept = baseAccepts.find((a) => a.scheme === "exact") ?? baseAccepts[0];
    const priceAtomic = chosenAccept ? Number(chosenAccept.amount) : NaN;
    const resourcePriceEntry =
      Number.isFinite(priceAtomic) && priceAtomic >= 0 ? [{ resource: item.resource, priceAtomic }] : [];
    const platformEntry = item.resource
      ? [{ url: item.resource, serviceName: item.serviceName ?? null }]
      : [];

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
        existing.resourcePrices.push(...resourcePriceEntry);
        // Dedupe by URL — a resource can appear more than once across
        // pages/scheme variants (see basePayTos comment above), and we
        // don't want the same platform URL listed twice for one wallet.
        if (platformEntry.length > 0 && !existing.platforms.some((p) => p.url === platformEntry[0]!.url)) {
          existing.platforms.push(...platformEntry);
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
          resourcePrices: [...resourcePriceEntry],
          platforms: [...platformEntry],
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
