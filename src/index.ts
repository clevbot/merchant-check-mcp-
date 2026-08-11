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
import { logQuery } from "./db/queries";
import type { Env } from "./types";
import { runRefresh } from "./refresh";
import { runCategorization } from "./categorize";
import { getDashboardData, renderDashboardHtml, dashboardDataToJson } from "./dashboard";

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
      "PAYOUT_ADDRESS is not set — run `wrangler secret put PAYOUT_ADDRESS` with a Base " +
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

  const paid = createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      description:
        "Context for agentic buying decisions: merchant risk and price fairness, backed by " +
        "real on-chain x402 settlement history.",
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
    extensions: declareDiscoveryExtension({
      toolName: "check_merchant",
      description:
        "Provides context for agentic buying decisions: call before completing an x402 " +
        "purchase to check merchant risk and price fairness, using real on-chain settlement " +
        "history. Returns a trust tier (trusted/caution/avoid) with reasons, the merchant's " +
        "category, and — if a price is given — whether it's fair versus peers in that category.",
      inputSchema: {
        type: "object",
        properties: {
          merchant_wallet_address: {
            type: "string",
            description: "EVM address of the merchant's receiving wallet",
          },
          price: {
            type: "number",
            description: "Quoted price in USD-equivalent, if checking fairness",
          },
        },
        required: ["merchant_wallet_address"],
      },
      example: { merchant_wallet_address: "0xffc458db291b4abce020fe3de4f91f2770e537b1", price: 0.05 },
      output: {
        example: {
          tier: "trusted",
          reasons: ["Consistent signals across wallet age, payer diversity, and settlement history"],
          price_fairness: "fair",
          category: "data_api",
        },
        schema: {
          type: "object",
          properties: {
            tier: { type: "string" },
            reasons: { type: "array" },
            price_fairness: { type: "string" },
            category: { type: ["string", "null"] },
          },
        },
      },
    }),
    hooks: {
      // Query-log write happens here (not inside the tool handler) so it
      // only fires once payment has actually settled — a definitively-paid
      // event, unlike "the handler ran" which createPaymentWrapper doesn't
      // expose a combined hook for. Trade-off: ServerHookContext doesn't
      // carry the tool's return value, so the actual tier isn't available
      // here — query_log is usage/revenue visibility only (see
      // db/schema.sql), not a scoring input, so this is an acceptable gap
      // for v1. Thread the real tier through if query_log ever needs it.
      onAfterSettlement: async ({ arguments: args, settlement }) => {
        const wallet = (args as { merchant_wallet_address?: string }).merchant_wallet_address;
        await logQuery(env, wallet ?? "unknown", settlement.payer ?? null, settlement.transaction ?? null, "settled");
      },
    },
  });

  mcp.tool(
    "check_merchant",
    "x402 Merchant Check — provides context for agentic buying decisions. Checks merchant " +
      "reliability and price fairness before purchase, using on-chain x402 transaction history. " +
      "Returns a tier (trusted/caution/avoid) with reasons, the merchant's category " +
      "(data_api/compute/content_generation/financial_data/storage/other, null if not yet " +
      "classified), and — if price is given — a price-fairness assessment compared against " +
      "other merchants in the same category. $0.01 USDC per query, paid via x402.",
    {
      merchant_wallet_address: z.string().describe("EVM address of the merchant's receiving wallet"),
      price: z.number().optional().describe("Quoted price in USD-equivalent, if checking fairness"),
      resource_type: z
        .string()
        .optional()
        .describe(
          "Deprecated, accepted but unused — price-fairness now compares against the merchant's " +
            "own on-chain-derived category automatically, no need to supply this.",
        ),
    },
    paid(async ({ merchant_wallet_address, price, resource_type }) => {
      const result = await checkMerchant(env, { merchant_wallet_address, price, resource_type });
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

    // Human-facing dashboard (gradientdecisions.com) and agent-facing MCP
    // endpoint (mcp.gradientdecisions.com) share this one Worker — routed
    // by pathname rather than hostname so it also works from the
    // workers.dev fallback URL and during local testing.
    if (url.pathname === "/" || url.pathname === "/dashboard") {
      const data = await getDashboardData(env);
      return new Response(renderDashboardHtml(data), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
      });
    }
    if (url.pathname === "/api/wallets") {
      return dashboardDataToJson(await getDashboardData(env));
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found. MCP endpoint is at /mcp, dashboard at /.", { status: 404 });
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
