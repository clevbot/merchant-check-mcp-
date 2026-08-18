/**
 * Solana data source for the refresh worker — mirrors indexer.ts's
 * BazaarDataSource role but for Solana x402 activity, which Bazaar (Base
 * mainnet only) has no visibility into at all.
 *
 * Two independent pieces, composed here into one ChainDataSource:
 *
 * 1. Discovery — PayAI Network's facilitator discovery feed
 *    (facilitator.payai.network/discovery/resources). Confirmed live via
 *    direct curl during research for this feature: 25,928 total items, a
 *    mixed Base+Solana catalog, same discovery-list JSON shape as x402
 *    Bazaar (items[].accepts[].{network,payTo,scheme,amount} +
 *    pagination.{limit,offset,total}). This is the real functional
 *    equivalent of what the original brief called "Solana's x402 Agent
 *    Registry" — that name doesn't correspond to an actual merchant
 *    catalog. solana.com/agent-registry is a *buyer*-side agent-identity
 *    product, not merchant discovery; PayAI's feed is the thing that
 *    actually lists Solana x402 resources. Free, public, no key required.
 *    Unlike Bazaar, PayAI's feed has no `quality` field on any sampled
 *    item — no call-volume or unique-payer counts ship with the listing
 *    itself, which is the gap piece 2 below fills.
 *
 * 2. Payer-diversity augmentation — Helius RPC (optional, HELIUS_API_KEY;
 *    see types.ts Env.HELIUS_API_KEY). For each Solana merchant wallet
 *    PayAI surfaced, counts USDC (SPL) transfers *to* that wallet within
 *    the refresh lookback window via Helius's Enhanced Transactions API,
 *    and the unique source addresses behind them. Entirely skipped — not
 *    estimated or guessed — when HELIUS_API_KEY is unset; those wallets
 *    keep PayAI's bare listing (usually 0 calls / 0 payers), which
 *    src/scoring.ts reads as "insufficient data" rather than "untrusted".
 *
 * Known caveats — see README "Solana signal caveats" for the full writeup:
 * - Helius counts *any* USDC transfer to a known merchant wallet, not
 *   specifically x402-protocol payments. A merchant receiving USDC through
 *   some other channel (a direct transfer, an unrelated payment app) would
 *   look like extra x402 volume here. Bazaar has the mirror-image gap
 *   (undercounting, since it only sees registered listings) — neither
 *   source is ground truth; both are documented approximations, not silent
 *   ones.
 * - firstSeenAt only reflects the earliest transfer *within the lookback
 *   window* fetched this run, capped by MAX_HELIUS_PAGES_PER_WALLET below —
 *   not true wallet age. A merchant active before the window, or with more
 *   transfers than the page cap covers, looks newer than it really is.
 *   Bazaar-sourced (Base) rows already have a similar null-vs-approximate
 *   tradeoff for this same signal (see indexer.ts) — this is the Solana
 *   analogue, made explicit rather than silently wrong.
 * - Fee-payer sponsorship in Solana's x402 "exact" scheme is NOT a source
 *   of misattribution here: the spec cryptographically excludes the
 *   fee-payer from being transfer source/authority/destination (see
 *   specs/schemes/exact/scheme_exact.md in x402-foundation/x402), so a
 *   counted transfer's source address is always the real payer, never a
 *   sponsoring relayer.
 * - Signal 6 (velocity/harness-break): STUBBED here exactly as it is for
 *   Base (see refresh/index.ts detectVelocityAnomalyStub) — always 0. When
 *   that pipeline gets built, it must NOT reuse Base-tuned thresholds
 *   unmodified for these rows — see db/schema.sql velocity_anomaly_flag
 *   comment and README "Solana signal caveats" (Solana finality is ~4x
 *   faster than Base's, so raw transaction-frequency thresholds tuned on
 *   Base would over-flag normal Solana activity as anomalous).
 */

import type { Chain } from "../chains";
import type { ChainDataSource, RawMerchantActivity } from "./indexer";

const PAYAI_DISCOVERY_URL = "https://facilitator.payai.network/discovery/resources";
/** Exported so other modules (e.g. src/dashboard.ts) filter on the same value rather than a second hardcoded copy. */
export const SOLANA_MAINNET_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAGE_SIZE = 100;
// Confirmed live via wrangler tail on 2026-08-12: this account's Worker
// invocation has a real ~50 *total* external-fetch (subrequest) budget, not
// the 1000 the D1-query-cap comments elsewhere assume (that's a separate,
// D1-specific limit) — a full run of BazaarDataSource (20 pages) +
// PayAIDataSource (originally 20 pages) + Helius augmentation (originally
// up to 150 calls) blew past it and the Worker was killed mid-refresh
// ("Too many subrequests by single Worker invocation"). Every fetch-issuing
// constant in this file is sized against a shared budget that assumes
// BazaarDataSource has already spent up to 20 of the ~50 before this file's
// code even runs (same invocation, sources run in sequence — see
// refresh/index.ts) — see MAX_HELIUS_WALLETS/MAX_HELIUS_PAGES_PER_WALLET
// below for the rest of that budget. Raising Cloudflare's Workers plan
// (Bundled/Paid raises this to 1000) would remove the need for this
// tight a budget entirely — flagged as a real option, not done here since
// it's a billing decision, not a code one.
const MAX_PAGES = 5; // 5 * 100 = up to 500 discovery items scanned per run, leaving budget for Helius below.

/** 6 decimals — cross-checked against x402scan's own facilitator constants and Solana's official USDC mint registry. Same decimal count as Base USDC, which is what makes the atomic-unit price comparison in db/queries.ts getComparablePrices valid across chains. */
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Helius calls are real network requests against a rate-limited (10 req/s,
// free tier) external API, unlike the single unauthenticated discovery fetch
// loop above — cap both how many wallets get augmented per refresh run and
// how deep each wallet's history gets paged. Sized against the ~50-subrequest
// invocation budget (see MAX_PAGES comment above) with real margin, not
// razor-thin: BazaarDataSource (≤20) + this file's own discovery pages (≤5)
// + Helius (≤8 here) + refresh/index.ts's own inline-categorization cap
// (≤8 Anthropic calls) totals ≤41 of ~50, leaving a ~9-request buffer for
// anything not accounted for above. This is a conservative slice of what's
// left, not "how much Helius's free tier alone could support" (that's a
// much higher number — 1M credits/month easily covers more than this).
// Raise this once Cloudflare's subrequest ceiling is actually raised
// (Workers Paid plan) rather than independently of it, or a wallet-by-wallet
// run stays capped by *this* budget regardless of how generous Helius's own
// free tier is.
const MAX_HELIUS_WALLETS = 8;
const MAX_HELIUS_PAGES_PER_WALLET = 1; // 100 most-recent txs considered per wallet — see README "Solana signal caveats" for why this is an approximation, not full history.

// Same underlying x402 discovery-list protocol shape as indexer.ts's Bazaar
// types — confirmed by comparing both feeds' JSON directly, not assumed.
interface DiscoveryAccept {
  network: string;
  payTo: string;
  scheme?: string;
  amount?: string;
}
interface DiscoveryItem {
  resource: string;
  accepts: DiscoveryAccept[];
  quality?: { l30DaysTotalCalls?: number; l30DaysUniquePayers?: number };
  description?: string;
  serviceName?: string;
  tags?: string[];
}
interface DiscoveryListResponse {
  items: DiscoveryItem[];
  pagination: { limit: number; offset: number; total: number };
}

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}
interface HeliusTransaction {
  signature: string;
  timestamp: number; // unix seconds
  tokenTransfers?: HeliusTokenTransfer[];
}

export class PayAIDataSource implements ChainDataSource {
  // Same warm-cache contract as BazaarDataSource: listActiveMerchants() must
  // run once before getMerchantActivity() is called, on the same instance.
  private cache = new Map<string, RawMerchantActivity>();

  constructor(private readonly heliusApiKey: string | undefined) {}

  async listActiveMerchants(sinceUnixSeconds: number): Promise<string[]> {
    this.cache.clear();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${PAYAI_DISCOVERY_URL}?limit=${PAGE_SIZE}&offset=${offset}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`PayAI discovery request failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as DiscoveryListResponse;
      for (const item of body.items) {
        this.ingestItem(item);
      }
      offset += PAGE_SIZE;
      if (offset >= body.pagination.total || body.items.length === 0) break;
    }

    // .trim() defensively: a `wrangler secret put` value pasted with a
    // trailing newline or stray whitespace looks identical in any
    // `wrangler secret list` output (which never shows values) but fails
    // key-equality checks server-side — confirmed as a real, live failure
    // mode 2026-08-12 (401s from a Worker-stored key that worked fine when
    // typed fresh in a terminal for the same account).
    const trimmedKey = this.heliusApiKey?.trim();
    if (trimmedKey) {
      await this.augmentWithHelius(sinceUnixSeconds, trimmedKey);
    }

    return [...this.cache.keys()];
  }

  async getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity> {
    // Solana addresses are base58 and case-sensitive — looked up exactly as
    // cached, no .toLowerCase() (contrast indexer.ts's Base equivalent).
    const activity = this.cache.get(walletAddress);
    if (!activity) {
      throw new Error(
        `No cached PayAI activity for ${walletAddress}. listActiveMerchants() must run ` +
          `first on this same PayAIDataSource instance.`,
      );
    }
    return activity;
  }

  private ingestItem(item: DiscoveryItem): void {
    // Dedup via a Set is safe without lowercasing: base58 has no case-fold
    // ambiguity (unlike EVM hex) to collapse across entries.
    const solanaPayTos = new Set(
      (item.accepts ?? [])
        .filter((a) => a.network === SOLANA_MAINNET_NETWORK && a.payTo)
        .map((a) => a.payTo),
    );
    // No `quality` field observed on any sampled PayAI item (confirmed via
    // direct curl during research) — defaults to 0/0 here. Real counts come
    // from augmentWithHelius() below when HELIUS_API_KEY is set; otherwise
    // this wallet stays at 0/0, which scoreMerchant() reads as insufficient
    // data rather than a trust signal either way.
    const calls = item.quality?.l30DaysTotalCalls ?? 0;
    const payers = item.quality?.l30DaysUniquePayers ?? 0;
    const descriptionPart = [item.serviceName, item.description, ...(item.tags ?? [])]
      .filter(Boolean)
      .join(". ");

    const solanaAccepts = (item.accepts ?? []).filter(
      (a) => a.network === SOLANA_MAINNET_NETWORK && a.amount,
    );
    const chosenAccept = solanaAccepts.find((a) => a.scheme === "exact") ?? solanaAccepts[0];
    const priceAtomic = chosenAccept ? Number(chosenAccept.amount) : NaN;
    const resourcePriceEntry =
      Number.isFinite(priceAtomic) && priceAtomic >= 0 ? [{ resource: item.resource, priceAtomic }] : [];
    const platformEntry = item.resource
      ? [{ url: item.resource, serviceName: item.serviceName ?? null }]
      : [];

    for (const wallet of solanaPayTos) {
      const existing = this.cache.get(wallet);
      if (existing) {
        existing.txCount += calls;
        existing.uniquePayerCount = Math.max(existing.uniquePayerCount, payers);
        if (descriptionPart) {
          existing.description = existing.description
            ? `${existing.description}. ${descriptionPart}`
            : descriptionPart;
        }
        existing.resourcePrices.push(...resourcePriceEntry);
        if (platformEntry.length > 0 && !existing.platforms.some((p) => p.url === platformEntry[0]!.url)) {
          existing.platforms.push(...platformEntry);
        }
      } else {
        this.cache.set(wallet, {
          walletAddress: wallet,
          network: SOLANA_MAINNET_NETWORK,
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

  /**
   * Overwrites txCount/uniquePayerCount/firstSeenAt with real Helius-indexed
   * USDC transfer data, for up to MAX_HELIUS_WALLETS of the wallets PayAI's
   * discovery feed surfaced. Wallets beyond the cap keep whatever PayAI gave
   * them (usually 0/0) — never a Helius-derived number for a wallet this run
   * didn't actually look up, so trust tiers stay honest about what was
   * measured this cycle.
   *
   * The slice rotates by a coarse time-based offset rather than always
   * taking the first MAX_HELIUS_WALLETS in cache order — found live
   * 2026-08-12: with a fixed `slice(0, N)`, every wallet past the cap
   * stayed at PayAI's bare 0/0 forever, cycle after cycle, since cache
   * insertion order (PayAI's own pagination order) doesn't change run to
   * run — the same N wallets got refreshed and the rest never did. Rotating
   * means every wallet eventually gets a turn across successive cron
   * cycles (4h apart — see wrangler.toml) instead of a permanently-stuck
   * remainder. With today's real catalog size (34 Solana wallets, cap of
   * 8/cycle) full coverage takes ~5 cycles (~20h) — acceptable for a
   * feature this new; revisit MAX_HELIUS_WALLETS as the real catalog grows.
   */
  private async augmentWithHelius(sinceUnixSeconds: number, apiKey: string): Promise<void> {
    const allWallets = [...this.cache.keys()];
    const cycleSeconds = 4 * 60 * 60; // matches wrangler.toml's refresh cron cadence
    const epoch = Math.floor(Date.now() / 1000 / cycleSeconds);
    const offset = allWallets.length > 0 ? epoch % allWallets.length : 0;
    const wallets: string[] = [];
    for (let i = 0; i < Math.min(MAX_HELIUS_WALLETS, allWallets.length); i++) {
      wallets.push(allWallets[(offset + i) % allWallets.length]!);
    }
    for (const wallet of wallets) {
      try {
        const { txCount, uniquePayers, firstSeenAt } = await fetchHeliusUsdcActivity(
          wallet,
          sinceUnixSeconds,
          apiKey,
        );
        const existing = this.cache.get(wallet)!;
        existing.txCount = txCount;
        existing.uniquePayerCount = uniquePayers.size;
        existing.firstSeenAt = firstSeenAt;
      } catch (err) {
        // One wallet's Helius call failing shouldn't abort the whole refresh
        // run — it just leaves that wallet at PayAI's bare (usually 0/0)
        // numbers, same outcome as if HELIUS_API_KEY were unset for it.
        console.error(`Helius augmentation failed for ${wallet}:`, err);
      }
    }
  }
}

async function fetchHeliusUsdcActivity(
  wallet: string,
  sinceUnixSeconds: number,
  apiKey: string,
): Promise<{ txCount: number; uniquePayers: Set<string>; firstSeenAt: number | null }> {
  const uniquePayers = new Set<string>();
  let txCount = 0;
  let firstSeenAt: number | null = null;
  let before: string | undefined;

  for (let page = 0; page < MAX_HELIUS_PAGES_PER_WALLET; page++) {
    // Confirmed live 2026-08-12 via wrangler tail: api.helius.xyz returns
    // 401 for this endpoint — Helius's current docs (helius.dev/docs/
    // api-reference/enhanced-transactions) put Enhanced Transactions API
    // calls on the same mainnet.helius-rpc.com host as their RPC endpoints,
    // not the older api.helius.xyz domain this originally assumed.
    const url = new URL(`https://mainnet.helius-rpc.com/v0/addresses/${wallet}/transactions`);
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Helius request failed for ${wallet}: ${res.status} ${res.statusText}`);
    }
    const txs = (await res.json()) as HeliusTransaction[];
    if (txs.length === 0) break;

    let hitWindowStart = false;
    for (const tx of txs) {
      if (tx.timestamp < sinceUnixSeconds) {
        hitWindowStart = true;
        break;
      }
      for (const transfer of tx.tokenTransfers ?? []) {
        if (transfer.mint !== USDC_SOLANA_MINT || transfer.toUserAccount !== wallet) continue;
        txCount++;
        if (transfer.fromUserAccount) uniquePayers.add(transfer.fromUserAccount);
        firstSeenAt = firstSeenAt === null ? tx.timestamp : Math.min(firstSeenAt, tx.timestamp);
      }
    }
    if (hitWindowStart) break;

    before = txs[txs.length - 1]?.signature;
    if (!before) break;
  }

  return { txCount, uniquePayers, firstSeenAt };
}

/** Re-exported so refresh/index.ts can tag rows from this source without a second literal. */
export const SOLANA_CHAIN: Chain = "solana";
