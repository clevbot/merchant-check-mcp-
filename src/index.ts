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
      serviceName: "Gradient Decisions — Merchant Check",
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
      "transaction history. Returns a tier (trusted/caution/avoid) with reasons, and — if a " +
      "price and resource_type are given — a price-fairness assessment. $0.01 USDC per query, " +
      "paid via x402.",
    {
      merchant_wallet_address: z.string().describe("EVM address of the merchant's receiving wallet"),
      price: z.number().optional().describe("Quoted price in USD-equivalent, if checking fairness"),
      resource_type: z
        .string()
        .optional()
        .describe("Category bucket for the resource being priced (required if price is given)"),
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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRefresh(env));
  },
} satisfies ExportedHandler<Env>;
