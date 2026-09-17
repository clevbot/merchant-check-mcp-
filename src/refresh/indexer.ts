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
// 20 pages * 100 = up to 2,000 resources scanned per refresh run. Bazaar had
// ~14.5k total resources as of 2026-08-10, ~15.9k as of 2026-09-17; raise
// this once refresh-worker runtime/cost at a wider per-run slice is known.
// Cheaper than it sounds since this is a single unauthenticated fetch loop,
// not per-wallet chain calls.
const MAX_PAGES = 20;
// Confirmed live 2026-09-17 by direct sampling (comparing each item's own
// `lastUpdated` at offset 0 vs. offset 2000 vs. offset 15000): Bazaar's feed
// is sorted newest-activity-first, not arbitrarily. Position ~2000 was
// already ~4 weeks stale; the tail is months old. This matters a lot for
// what "rotating through the catalog" (added earlier the same day) actually
// does: uniform rotation treats a page of months-old dead listings as
// equally worth a scan as the freshest page, which very concretely isn't
// true — real data confirmed on the Solana side (src/refresh/solana-
// indexer.ts's identical FRESH_PAGES fix) that most merchants surfaced this
// way have near-zero real activity and can't be scored above INSUFFICIENT_
// SIGNAL anyway. FRESH_PAGES are rescanned every single cycle regardless of
// rotation — this is where real, current, scoreable activity actually is —
// and only the remaining (MAX_PAGES - FRESH_PAGES) budget rotates through
// the older tail, as a slow backfill, not the primary growth strategy.
const FRESH_PAGES = 5; // 500 freshest items, rescanned every cycle unconditionally.

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

    // Pages 0..FRESH_PAGES-1 are always scanned, every cycle, unconditionally
    // — see FRESH_PAGES' own comment for why: this is where real, current,
    // scoreable merchant activity actually lives, confirmed by direct
    // sampling of the feed's own `lastUpdated` ordering. Page 0's response
    // also gives pagination.total, which the rotation below needs and which
    // isn't knowable ahead of time.
    let total = 0;
    for (let page = 0; page < FRESH_PAGES; page++) {
      const offset = page * PAGE_SIZE;
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
      total = body.pagination.total;
      if (offset + PAGE_SIZE >= total || body.items.length === 0) break; // catalog smaller than FRESH_PAGES itself
    }
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Rotate which of the REMAINING (MAX_PAGES - FRESH_PAGES) pages get
    // scanned each cycle — a slow backfill sweep through the older tail
    // beyond the fresh window above, not the primary growth strategy (see
    // FRESH_PAGES' own comment). Same underlying rotation mechanism first
    // added 2026-09-17 (deterministic epoch/cadence math, no state to
    // persist across runs), refined the same day once the feed turned out
    // to be recency-sorted rather than arbitrary.
    const remainingPageBudget = MAX_PAGES - FRESH_PAGES;
    const rotatablePages = Math.max(1, totalPages - FRESH_PAGES); // excludes the fresh pages, already covered above
    const cycleSeconds = 2 * 60 * 60; // matches wrangler.toml's refresh cron cadence
    const epoch = Math.floor(Date.now() / 1000 / cycleSeconds);
    const startIndex = epoch % rotatablePages;

    for (let i = 0; i < remainingPageBudget; i++) {
      const pageNum = FRESH_PAGES + ((startIndex + i) % rotatablePages);
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
