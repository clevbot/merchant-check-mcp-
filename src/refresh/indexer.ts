/**
 * On-chain data source abstraction for the refresh worker.
 *
 * Decision (2026-08-10): no indexer was already in use for the buyer-side
 * wallet-harness pipeline (it doesn't exist yet either — see runRefresh's
 * velocity/harness-anomaly stub). Proposed default here: Coinbase's CDP
 * Data API, since Cloudflare's own x402 examples and the public facilitator
 * are already a Coinbase/CDP surface, so wallet-activity queries likely
 * share auth/infra with the facilitator you're already calling. This is a
 * proposal, not a commitment — swap the implementation below for whatever
 * you actually provision (a subgraph, Dune, your own RPC-log indexer) by
 * implementing the same ChainDataSource interface.
 *
 * Needs an actual CDP API key before this can run for real — see README.
 */

export interface RawMerchantActivity {
  walletAddress: string;
  firstSeenAt: number | null; // unix seconds
  txCount: number;
  uniquePayers: string[];
  completedFlows: number;
  abandonedFlows: number;
  refunds: number;
  refundEligibleVolume: number;
  priceObservations: { resourceType: string; priceAtomic: number; payer: string; at: number }[];
}

export interface ChainDataSource {
  /** All merchant wallets with x402 activity since `sinceUnixSeconds`. */
  listActiveMerchants(sinceUnixSeconds: number): Promise<string[]>;
  getMerchantActivity(walletAddress: string): Promise<RawMerchantActivity>;
}

export class CdpDataApiSource implements ChainDataSource {
  constructor(
    private readonly apiKey: string,
    private readonly network: string,
  ) {}

  async listActiveMerchants(_sinceUnixSeconds: number): Promise<string[]> {
    throw new Error(
      "CdpDataApiSource.listActiveMerchants not implemented — needs a provisioned " +
        "CDP Data API key and its actual query shape confirmed against current docs " +
        "before wiring this up. Stubbed intentionally; see README 'Data source'.",
    );
  }

  async getMerchantActivity(_walletAddress: string): Promise<RawMerchantActivity> {
    throw new Error("CdpDataApiSource.getMerchantActivity not implemented — see listActiveMerchants.");
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
