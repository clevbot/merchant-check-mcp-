import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper } from "@x402/mcp";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { z } from "zod";
import { checkMerchant } from "./tool";
import { logQuery, getMetricsSummary } from "./db/queries";
import type { CheckMerchantOutput, Env } from "./types";
import { runRefresh } from "./refresh";
import { runCategorization } from "./categorize";
import { getCallerAnalytics, renderCallerDashboardHtml, callerAnalyticsToJson } from "./callerDashboard";
import { renderPrivacyPolicyHtml } from "./privacy";
import { renderHomePlaceholderHtml } from "./homePlaceholder";
import { getDashboardSummary } from "./dashboard";
import { ROBOTS_TXT, renderHomeMarkdown, renderSitemapXml, wantsMarkdown } from "./agentReadiness";

/**
 * Payment stack: @x402/core + @x402/evm + @x402/mcp — the official Coinbase/
 * x402-foundation packages (same publishers as the protocol itself), not
 * x402-hono. x402-hono gates by HTTP route, which doesn't fit MCP: every
 * JSON-RPC method (initialize, tools/list, tools/call) shares one POST
 * endpoint, and gating the whole route would paywall tools/list too,
 * breaking free agent discovery. @x402/mcp's createPaymentWrapper instead
 * wraps a *specific tool handler*, so tools/list stays free and only
 * check_merchant's tools/call is metered. See package.json comment history
 * / README for why this replaced an earlier hand-rolled attempt.
 *
 * MCP transport: @modelcontextprotocol/sdk's WebStandardStreamableHTTPServerTransport
 * — a fetch()/Request/Response-based transport explicitly documented as
 * Workers-compatible (its own JSDoc includes a Cloudflare Workers example).
 * Cloudflare's `agents` package (createMcpHandler) was the initial plan but
 * was dropped: @x402/mcp is built against @modelcontextprotocol/sdk
 * directly, and mixing it with `agents`' own McpServer wrapper wasn't worth
 * the risk of an unproven combination in payment-handling code.
 */

/** Must match the second cron expression in wrangler.toml's [triggers]. */
const MONTHLY_CATEGORIZATION_CRON = "0 0 1 * *";

let resourceServerPromise: Promise<x402ResourceServer> | null = null;

function getResourceServer(env: Env): Promise<x402ResourceServer> {
  if (!resourceServerPromise) {
    resourceServerPromise = (async () => {
      // The free public x402.org facilitator (previously hardcoded via
      // env.X402_FACILITATOR_URL) is testnet-only by design — found this
      // out the hard way, via a real failed mainnet call: "Facilitator
      // does not support exact on eip155:8453." Base mainnet settlement
      // needs Coinbase's CDP
      // production facilitator, which requires CDP API key auth.
      // createFacilitatorConfig (the official @coinbase/x402 package, same
      // publisher as the protocol) points at the correct CDP endpoint and
      // handles the JWT auth signing internally — passing undefined here is
      // intentional until CDP_API_KEY_ID/SECRET are set (see README): the
      // facilitator will reject verify/settle calls with a clear auth error
      // rather than silently accepting unauthenticated mainnet requests.
      const facilitator = new HTTPFacilitatorClient(
        createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
      );
      const server = new x402ResourceServer(facilitator);
      server.register(env.X402_NETWORK as Network, new ExactEvmScheme());
      // Required for x402 Bazaar discovery to pick up check_merchant at all
      // — without this, the per-tool discovery metadata declared on
      // createPaymentWrapper below (extensions: declareDiscoveryExtension)
      // is inert. Per Coinbase's own docs, listing itself needs no manifest
      // or registration form: discovery metadata is submitted automatically
      // the moment a real payment settles through the CDP facilitator with
      // this extension registered — see README "x402 Bazaar listing".
      server.registerExtension(bazaarResourceServerExtension);
      await server.initialize();
      return server;
    })();
  }
  return resourceServerPromise;
}

async function buildAccepts(env: Env, server: x402ResourceServer): Promise<PaymentRequirements[]> {
  if (!env.PAYOUT_ADDRESS) {
    throw new Error(
      "PAYOUT_ADDRESS is not set. Run `wrangler secret put PAYOUT_ADDRESS` with a Base " +
        "wallet address you control before this endpoint can charge for queries. See README.",
    );
  }
  return server.buildPaymentRequirements({
    scheme: "exact",
    network: env.X402_NETWORK as Network,
    payTo: env.PAYOUT_ADDRESS,
    price: "$0.01",
  });
}

function createServer(env: Env, accepts: PaymentRequirements[], resourceServer: x402ResourceServer) {
  const mcp = new McpServer({ name: "merchant-check-mcp", version: "0.1.0" });

  // Closure-captured, set by the tool handler right before it returns and
  // read by onAfterSettlement below — both closures live inside this same
  // createServer() call, which fetch() (bottom of this file) invokes fresh
  // per request, so this is safely request-scoped, not shared state across
  // requests. Exists to fix a real, previously-documented gap (see
  // db/schema.sql query_log.tier_returned comment): createPaymentWrapper's
  // ServerHookContext doesn't carry the tool handler's return value, only
  // payment/settlement info, so onAfterSettlement had no way to log the
  // real recommendation before this — every row logged "settled" as a
  // placeholder. latencyStartedAt is stamped at the same point, so
  // onAfterSettlement can also report real request latency.
  let lastResult: CheckMerchantOutput | null = null;
  let latencyStartedAt: number | null = null;

  const paid = createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      description:
        "Pre-payment assessment of a merchant's observable on-chain payment behavior, backed by " +
        "real x402 settlement history on Base and Solana. Decision support, not a certification.",
      // serviceName is validated against @x402/core's ResourceInfoSchema:
      // printable-ASCII only (no em-dash) and <=32 chars. Learned this by
      // hitting a real ZodError from the deployed endpoint, not from docs.
      // Renamed from "Gradient Decisions" (the parent company) to the
      // product name — "x402" in the name is deliberate for discoverability
      // by anyone specifically searching for x402-compatible tools.
      serviceName: "x402 Merchant Check",
    },
    // x402 Bazaar discovery metadata — a tool call, not an HTTP route, is
    // only listable at all because @x402/mcp exposes this hook (Bazaar's
    // own published docs describe HTTP-route discovery only; found this via
    // a JSDoc example inside @x402/mcp's own type declarations, not the
    // docs site). description is written to answer Bazaar's stated
    // requirement: tell an agent *when* to use this, not just what it does.
    //
    // Wording note (requirement 9 + pre-payment-primitive rework,
    // 2026-08-12): written for semantic-intent matching against how an
    // agent would actually phrase a need — "is it safe to buy from this
    // seller", "compare these vendors", "is this price reasonable" —
    // rather than internal jargon like "on-chain trust scoring" or
    // "harness-break detection" that wouldn't appear in a natural request.
    // Explicitly frames this as a PRE-PAYMENT check triggered by
    // marketplace discovery (Coinbase x402 Bazaar named directly, since
    // that's the concrete trigger moment this tool is meant to slot into),
    // and uses evidence/assessment language rather than certification
    // language: "observed behavior supports X" not "this merchant is
    // safe," "assessment"/"evidence" not "guaranteed"/"certified"/
    // "fraud-free" — this is decision support drawn from observable
    // behavior, not a safety guarantee, and the wording must not imply
    // otherwise. Mentions Base and Solana explicitly so an agent shopping
    // on either chain recognizes this tool as relevant.
    extensions: declareDiscoveryExtension({
      toolName: "check_merchant",
      description:
        "Before paying an unfamiliar merchant via x402, including one just discovered through " +
        "a marketplace like Coinbase's x402 Bazaar, call this for a machine-readable assessment " +
        "of their observable on-chain payment behavior, on Base or Solana. Returns a " +
        "`recommendation` (PROCEED / CAUTION / INSUFFICIENT_SIGNAL) a payment policy can branch " +
        "on directly, plus supporting evidence: trust tier, confidence, payer diversity, " +
        "transaction history, category, known platform URL(s), and the merchant's own " +
        "advertised price(s) compared against category peers, with no caller-supplied price " +
        "required for that. This is decision support drawn from observed behavior, not a " +
        "certification. PROCEED means the available evidence doesn't show cause for concern, " +
        "not a guarantee of safety. Add a specific quoted price to also check that exact " +
        "figure against comparable sellers.",
      inputSchema: {
        type: "object",
        properties: {
          merchant_wallet_address: {
            type: "string",
            description: "Merchant's receiving wallet address: a Base (0x...) or Solana (base58) address. Usually extractable directly from a 402 Payment Required response's accepts[].payTo.",
          },
          price: {
            type: "number",
            description: "Quoted price in USD-equivalent, if checking fairness",
          },
          network: {
            type: "string",
            description: "Optional. CAIP-2 network id from the 402 response's accepts[].network (e.g. \"eip155:8453\"), if the caller already has it on hand. Not required to score.",
          },
          asset: {
            type: "string",
            description: "Optional. Payment asset/token from the 402 response's accepts[].asset. Not required to score.",
          },
          amount: {
            type: "string",
            description: "Optional. Atomic payment amount from the 402 response's accepts[].amount, if a caller has it and prefers it over `price`. Not required to score.",
          },
          service_url: {
            type: "string",
            description: "Optional. The resource/service URL the agent was trying to reach. Not required to score.",
          },
        },
        required: ["merchant_wallet_address"],
      },
      example: { merchant_wallet_address: "0xffc458db291b4abce020fe3de4f91f2770e537b1", price: 0.05 },
      output: {
        example: {
          merchant: "0xffc458db291b4abce020fe3de4f91f2770e537b1",
          network: "eip155:8453",
          recommendation: "PROCEED",
          trust_tier: "TRUSTED",
          confidence: "HIGH",
          data_sufficiency: "SUFFICIENT",
          signals: {
            merchant_age_days: 184,
            unique_payers: 51,
            total_tx_count: 89635,
            payer_concentration: "LOW",
          },
          risk_flags: [],
          reasons: ["Consistent signals across wallet age, payer diversity, and settlement history"],
          price_fairness: "fair",
          pricing: { advertised_prices_atomic: [50000], fairness_vs_category: "fair" },
          category: "data_api",
          chain: "base",
          platforms: [{ url: "https://api.example.com/v1/weather", serviceName: "Weather API" }],
        },
        schema: {
          type: "object",
          properties: {
            merchant: { type: "string" },
            network: { type: ["string", "null"] },
            recommendation: { type: "string" },
            trust_tier: { type: ["string", "null"] },
            confidence: { type: "string" },
            data_sufficiency: { type: "string" },
            signals: { type: "object" },
            risk_flags: { type: "array" },
            reasons: { type: "array" },
            price_fairness: { type: "string" },
            pricing: { type: "object" },
            category: { type: ["string", "null"] },
            chain: { type: ["string", "null"] },
            platforms: { type: "array" },
          },
        },
      },
    }),
    hooks: {
      // Query-log write happens here (not inside the tool handler) so it
      // only fires once payment has actually settled — a definitively-paid
      // event, unlike "the handler ran" which createPaymentWrapper doesn't
      // expose a combined hook for. tier/recommendation/latency now come
      // from the lastResult/latencyStartedAt closure above (fixed
      // 2026-08-12 — see that comment for why this previously logged a
      // "settled" placeholder instead).
      onAfterSettlement: async ({ arguments: args, settlement }) => {
        const typedArgs = args as { merchant_wallet_address?: string; price?: number };
        const wallet = typedArgs.merchant_wallet_address;
        const latencyMs = latencyStartedAt !== null ? Date.now() - latencyStartedAt : null;
        // price is USD-equivalent from the caller, same conversion src/tool.ts
        // uses for price_fairness — stored atomic so it's comparable to
        // price_observations without a unit mismatch.
        const callerSuppliedPriceAtomic =
          typedArgs.price !== undefined ? Math.round(typedArgs.price * 1_000_000) : null;
        await logQuery(env, {
          queriedWallet: wallet ?? "unknown",
          payerAddress: settlement.payer ?? null,
          txHash: settlement.transaction ?? null,
          tierReturned: lastResult?.trust_tier ?? "settled", // fallback preserves the old placeholder if lastResult somehow wasn't captured, rather than writing NULL and losing the row's meaning entirely
          recommendation: lastResult?.recommendation ?? null,
          latencyMs,
          queriedCategory: lastResult?.category ?? null,
          callerSuppliedPriceAtomic,
        });
      },
    },
  });

  // Same wording intent as the declareDiscoveryExtension description above
  // (requirement 9 + pre-payment-primitive rework) — this is the field MCP
  // clients actually match tool calls against, so it carries the primary
  // semantic-intent phrasing. Kept in sync with the Bazaar description
  // rather than duplicated divergently, since both describe the same
  // underlying tool call.
  mcp.tool(
    "check_merchant",
    "Before paying an unfamiliar merchant via x402, including one just discovered through a " +
      "marketplace like Coinbase's x402 Bazaar, call this for a machine-readable assessment of " +
      "their observable on-chain payment behavior, on Base or Solana. Returns a `recommendation` " +
      "(PROCEED / CAUTION / INSUFFICIENT_SIGNAL) a payment policy can branch on directly, plus " +
      "supporting evidence: trust tier, confidence, payer diversity, transaction history, " +
      "category (data_api/compute/content_generation/financial_data/storage/other), known " +
      "platform URL(s), and the merchant's own advertised price(s) compared against category " +
      "peers, with no caller-supplied price required for that. This is decision support drawn " +
      "from observed behavior, not a certification. PROCEED means the available evidence " +
      "doesn't show cause for concern, not a guarantee of safety. INSUFFICIENT_SIGNAL means " +
      "there isn't enough history to say either way, distinct from an actual concern. Add a " +
      "specific quoted price to also check that exact figure against comparable sellers. " +
      "$0.01 USDC per check, paid via x402.",
    {
      merchant_wallet_address: z
        .string()
        .describe(
          "Merchant's receiving wallet address: a Base (0x...) or Solana (base58) address. " +
            "Usually extractable directly from a 402 Payment Required response's accepts[].payTo.",
        ),
      price: z.number().optional().describe("Quoted price in USD-equivalent, if checking fairness"),
      network: z
        .string()
        .optional()
        .describe(
          "Optional. CAIP-2 network id from the 402 response's accepts[].network (e.g. " +
            '"eip155:8453"), if already on hand. Not required to score.',
        ),
      asset: z
        .string()
        .optional()
        .describe("Optional. Payment asset/token from the 402 response's accepts[].asset. Not required to score."),
      amount: z
        .string()
        .optional()
        .describe(
          "Optional. Atomic payment amount from the 402 response's accepts[].amount, if preferred " +
            "over `price`. Not required to score.",
        ),
      service_url: z
        .string()
        .optional()
        .describe("Optional. The resource/service URL the agent was trying to reach. Not required to score."),
      resource_type: z
        .string()
        .optional()
        .describe(
          "Deprecated, accepted but unused. Price-fairness now compares against the merchant's " +
            "own on-chain-derived category automatically, no need to supply this.",
        ),
    },
    paid(async ({ merchant_wallet_address, price, network, asset, amount, service_url, resource_type }) => {
      latencyStartedAt = Date.now();
      const result = await checkMerchant(env, {
        merchant_wallet_address,
        price,
        network,
        asset,
        amount,
        service_url,
        resource_type,
      });
      lastResult = result; // read by onAfterSettlement above, once payment actually settles
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }),
  );

  return mcp;
}

// Domain-ownership proof for the official MCP Registry's HTTP auth method
// (docs/authentication.mdx "HTTP Authentication") — lets mcp-publisher
// authenticate as gradientdecisions.com without any GitHub OAuth. The
// corresponding private key lives only in this session's scratchpad, never
// committed; this public value is the whole point of being public.
const MCP_REGISTRY_AUTH_RECORD = "v=MCPv1; k=ed25519; p=qoOP77GDo1BCijstKpdrVMh0ldDT5gh2ilyR4SslUtY=\n";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/mcp-registry-auth") {
      return new Response(MCP_REGISTRY_AUTH_RECORD, { headers: { "Content-Type": "text/plain" } });
    }

    // Manual trigger for the refresh worker (src/refresh) — gated by a
    // shared-secret header, not just discoverability-through-obscurity.
    // Exists because the cron trigger can't attach until the account has a
    // workers.dev subdomain enabled (see README); useful afterwards too, as
    // an on-demand refresh outside the 4-hour cadence.
    if (url.pathname === "/refresh" && request.method === "POST") {
      if (request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN || !env.ADMIN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      await runRefresh(env);
      return new Response("ok", { status: 200 });
    }

    // Manual trigger for src/categorize — deliberately separate from
    // /refresh (requirement 6: categorization runs on its own, much slower
    // cadence, not the 4-hour trust-signal schedule). Without ?force=true,
    // only categorizes wallets that don't have one yet (catch-up/backfill,
    // and the normal path since first-ingestion categorization already
    // happens inline in runRefresh — see src/refresh/index.ts). With
    // ?force=true, re-categorizes everyone (the monthly cron below), oldest
    // category_updated_at first, capped at `limit` per call — call again to
    // continue a large force run across multiple invocations.
    if (url.pathname === "/categorize" && request.method === "POST") {
      if (request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN || !env.ADMIN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const force = url.searchParams.get("force") === "true";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : undefined;
      const result = await runCategorization(env, { force, limit });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Observability for the adoption hypothesis (brief section 11) — admin-
    // gated like /refresh and /categorize since this is operational/revenue
    // visibility, not something to expose publicly by default. ?window=
    // in seconds, defaults to 7 days. See db/queries.ts getMetricsSummary
    // for exactly what this can and can't measure.
    if (url.pathname === "/metrics" && request.method === "GET") {
      if (request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN || !env.ADMIN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const windowParam = url.searchParams.get("window");
      const windowSeconds = windowParam ? Number(windowParam) : 7 * 24 * 60 * 60;
      const summary = await getMetricsSummary(env, windowSeconds);
      return new Response(JSON.stringify(summary, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Internal caller-tracking dashboard (2026-08-13) — separate from the
    // public merchant-scoring dashboard below on purpose: this tracks who's
    // *calling* check_merchant (confirmed-intent buyer-side data), not
    // which merchants score well. Admin-gated, not linked from the public
    // site, no off-chain identity resolution — see src/callerDashboard.ts
    // module comment for the full design constraints. ?window= in seconds,
    // defaults to 7 days for the headline stats; the 30-day retention view
    // and all-time frequency table are always full-range regardless of
    // ?window (see getCallerAnalytics).
    if (url.pathname === "/admin/callers" && request.method === "GET") {
      if (request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN || !env.ADMIN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const windowParam = url.searchParams.get("window");
      const windowSeconds = windowParam ? Number(windowParam) : 7 * 24 * 60 * 60;
      const analytics = await getCallerAnalytics(env, windowSeconds);
      if (url.searchParams.get("format") === "json") {
        return callerAnalyticsToJson(analytics);
      }
      return new Response(renderCallerDashboardHtml(analytics), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Human-facing homepage (gradientdecisions.com) and agent-facing MCP
    // endpoint (mcp.gradientdecisions.com) share this one Worker — routed
    // by pathname rather than hostname so it also works from the
    // workers.dev fallback URL and during local testing.
    //
    // 2026-08-19: this used to render the full live dashboard (every scored
    // merchant's recommendation/signals/pricing, straight from D1). Locked
    // down — see "Data access policy" in README — because that gave any
    // agent (or script) the exact same read `check_merchant` charges
    // $0.01/query for, completely free, which undercut the paid product
    // this whole system exists to sell. Aggregate-only summary stats added
    // back the same day at the user's request (total merchants, PROCEED/
    // CAUTION/INSUFFICIENT_SIGNAL counts, per-chain breakdown) — safe to
    // publish since getDashboardSummary() never pulls per-merchant data out
    // of D1 in the first place, not just withholds it at render time. The
    // real redesigned per-merchant dashboard is still a separate, later
    // task built from Figma mockups, not rebuilt here.
    if (url.pathname === "/" || url.pathname === "/dashboard") {
      const summary = await getDashboardSummary(env);
      // Content negotiation on Accept: text/markdown (2026-08-19, "Agent
      // Readiness" quick win) — same signal Cloudflare's own Pro-only
      // "Markdown for Agents" feature keys off, implemented here for free.
      // Vary: Accept so any downstream/edge cache keys on it and never
      // serves the wrong format to the next requester.
      if (wantsMarkdown(request)) {
        return new Response(renderHomeMarkdown(summary), {
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=60", Vary: "Accept" },
        });
      }
      return new Response(renderHomePlaceholderHtml(summary), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60", Vary: "Accept" },
      });
    }
    // "Agent Readiness" quick wins (2026-08-19) — robots.txt (with explicit
    // AI-crawler allow rules and a Content-Signal line) and sitemap.xml, so
    // the Cloudflare diagnostic's "Quick Wins" checks pass without needing
    // its dashboard-side AI Crawl Control config. See src/agentReadiness.ts.
    if (url.pathname === "/robots.txt") {
      return new Response(ROBOTS_TXT, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response(renderSitemapXml(), {
        headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }
    // 2026-08-19: retired, same reasoning as the homepage above — this was
    // the raw-JSON version of the same full dataset (every field the
    // scoring engine produces, straight from D1), the single most direct
    // leak vector of all: no rendering, no throttling, trivially scriptable.
    // Matches on prefix and every HTTP method (not just GET) so
    // `/api/wallets/`, `/api/wallets?chain=base`, HEAD, OPTIONS, POST, etc.
    // all land here too rather than falling through to some other handler.
    // No CORS headers, no-store so nothing stale gets served from cache —
    // see README "Data access policy" for the full writeup.
    if (url.pathname === "/api/wallets" || url.pathname.startsWith("/api/wallets/")) {
      return new Response("Not found.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    // 2026-08-19: retired for the identical reason — a per-merchant profile
    // page still returns the same recommendation/signals/pricing/reasons
    // fields the paid tool sells, and an agent calling check_merchant
    // already has the one wallet address it would need to read this page
    // directly instead of paying. Code stays in src/merchantProfile.ts
    // (unused, not deleted) in case a future paid or curated variant reuses
    // it; not routed publicly. Matches on prefix + every method, same as
    // /api/wallets above.
    if (url.pathname === "/merchant" || url.pathname.startsWith("/merchant/")) {
      return new Response("Not found.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/privacy") {
      return new Response(renderPrivacyPolicyHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found. MCP endpoint is at /mcp.", { status: 404 });
    }

    const resourceServer = await getResourceServer(env);
    const accepts = await buildAccepts(env, resourceServer);
    const mcp = createServer(env, accepts, resourceServer);

    // Stateless mode: no sessionIdGenerator, matching the Workers-per-request
    // model — see WebStandardStreamableHTTPServerTransport's own docs.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    return transport.handleRequest(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two cron expressions in wrangler.toml drive this one handler — branch
    // on which fired rather than always doing both, since categorization is
    // deliberately not on the trust-signal refresh's 4-hour cadence.
    if (controller.cron === MONTHLY_CATEGORIZATION_CRON) {
      ctx.waitUntil(runCategorization(env, { force: true }));
    } else {
      ctx.waitUntil(runRefresh(env));
    }
  },
} satisfies ExportedHandler<Env>;
