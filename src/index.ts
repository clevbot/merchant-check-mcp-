import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper } from "@x402/mcp";
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
      const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });
      const server = new x402ResourceServer(facilitator);
      server.register(env.X402_NETWORK as Network, new ExactEvmScheme());
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
      description: "Merchant risk/reputation and price-fairness check, backed by on-chain x402 history.",
      // serviceName is validated against @x402/core's ResourceInfoSchema:
      // printable-ASCII only (no em-dash) and <=32 chars. Learned this by
      // hitting a real ZodError from the deployed endpoint, not from docs.
      serviceName: "Gradient Decisions",
    },
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
    "Checks merchant reliability and price fairness before purchase, using on-chain x402 " +
      "transaction history. Returns a tier (trusted/caution/avoid) with reasons, the merchant's " +
      "category (data_api/compute/content_generation/financial_data/storage/other, null if not " +
      "yet classified), and — if price is given — a price-fairness assessment compared against " +
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
