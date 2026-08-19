/**
 * GET /check — plain-HTTP x402 mirror of the check_merchant MCP tool
 * (2026-08-19), added at the user's explicit request after investigating
 * why Cloudflare's Agent Readiness scanner reported "x402 payment protocol
 * not detected." Root cause, confirmed via the scanner's own audit log
 * (src/agentReadiness.ts x402 Protocol comment): it only sends plain GET
 * requests to generic paths looking for a literal HTTP 402 status. It
 * never sends the JSON-RPC `tools/call` that triggers check_merchant's
 * real x402 challenge — which arrives embedded in a 200 OK JSON-RPC
 * response body, an inherent property of JSON-RPC over HTTP, not a bug.
 * A plain HTTP client (or this scanner) hitting `/mcp` with a bare GET
 * was never going to see a 402, no matter how correctly x402 is wired.
 *
 * This route is NOT a new payment rail or new financial infrastructure:
 * same PAYOUT_ADDRESS wallet, same CDP facilitator, same $0.01 price,
 * same checkMerchant() scoring logic, same query_log write as the MCP
 * tool (src/index.ts) — just a second, simpler HTTP entry point onto the
 * identical, already-proven real settlement path, built with @x402/core's
 * own x402HTTPResourceServer (the framework-agnostic HTTP counterpart to
 * @x402/mcp's createPaymentWrapper, which only wraps MCP tool handlers).
 * Considered and explicitly rejected as a fit here: MPP (needs our own
 * on-chain relayer + funded gas wallet — real new infra, not a docs
 * change; see conversation), ACP/UCP/AP2 (retail-checkout or delegated-
 * mandate shapes that don't match a single metered API call regardless
 * of effort — see src/agentReadiness.ts's MCP Server Card comment for the
 * full per-protocol reasoning).
 */
import { x402HTTPResourceServer } from "@x402/core/http";
import type { HTTPAdapter, RoutesConfig } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import type { x402ResourceServer } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { checkMerchant } from "./tool";
import { logQuery } from "./db/queries";
import { SAMPLE_CHECK_MERCHANT_INPUT, SAMPLE_CHECK_MERCHANT_OUTPUT } from "./agentReadiness";
import type { CheckMerchantInput, Env } from "./types";

/**
 * Minimal HTTPAdapter over the standard Fetch API `Request` — Cloudflare
 * Workers use the real Web Request/URL classes natively, so this is a
 * direct mapping, not an approximation of some other framework's request
 * object. @x402/core ships no adapter of its own for the plain Fetch API
 * (only frameworks like Hono have community adapters), so this is genuinely
 * new (small) glue code, not a reimplementation of something that already
 * existed.
 */
class FetchRequestAdapter implements HTTPAdapter {
  private readonly url: URL;
  constructor(private readonly request: Request) {
    this.url = new URL(request.url);
  }
  getHeader(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }
  getMethod(): string {
    return this.request.method;
  }
  getPath(): string {
    return this.url.pathname;
  }
  getUrl(): string {
    return this.request.url;
  }
  getAcceptHeader(): string {
    return this.request.headers.get("accept") ?? "";
  }
  getUserAgent(): string {
    return this.request.headers.get("user-agent") ?? "";
  }
  getQueryParams(): Record<string, string> {
    return Object.fromEntries(this.url.searchParams.entries());
  }
  getQueryParam(name: string): string | undefined {
    return this.url.searchParams.get(name) ?? undefined;
  }
}

let httpServerPromise: Promise<x402HTTPResourceServer> | null = null;

/**
 * Memoized per-isolate, same pattern as src/index.ts's getResourceServer —
 * initialize() validates the route's payment config against the
 * facilitator once, not on every request. Takes the already-initialized
 * x402ResourceServer (same one the MCP path uses) rather than building a
 * second one, so both entry points share one facilitator connection and
 * one set of registered schemes.
 */
function getHttpResourceServer(env: Env, resourceServer: x402ResourceServer): Promise<x402HTTPResourceServer> {
  if (!httpServerPromise) {
    httpServerPromise = (async () => {
      const routes: RoutesConfig = {
        "GET /check": {
          accepts: {
            scheme: "exact",
            network: env.X402_NETWORK as Network,
            payTo: env.PAYOUT_ADDRESS,
            price: "$0.01",
          },
          description:
            "Pre-payment assessment of a merchant's observable on-chain payment behavior, backed by " +
            "real x402 settlement history on Base and Solana. Decision support, not a certification.",
          mimeType: "application/json",
          serviceName: "x402 Merchant Check",
          // Bazaar discovery metadata (2026-08-19, found missing while
          // investigating why real settled payments on this exact route
          // never triggered a Bazaar listing) — per docs.x402.org/extensions/
          // bazaar, cataloging happens when a paying client echoes the
          // extension data a server declared in its 402 challenge; this
          // route never declared any extension at all, so there was
          // nothing for any client to echo, independent of anything the
          // *client* side does. The MCP path (src/index.ts) already
          // declares this via createPaymentWrapper's own `extensions`
          // option; this is the HTTP-route equivalent, using the "GET with
          // query params" variant of declareDiscoveryExtension (see its
          // own JSDoc examples) since merchant_wallet_address arrives as a
          // query param here, not a tool argument or JSON body. Reuses the
          // same canonical sample input/output as auth.md and the MCP
          // path's own declaration (src/agentReadiness.ts) rather than a
          // third copy.
          extensions: declareDiscoveryExtension({
            input: SAMPLE_CHECK_MERCHANT_INPUT,
            inputSchema: {
              properties: {
                merchant_wallet_address: {
                  type: "string",
                  description: "Merchant's receiving wallet address: a Base (0x...) or Solana (base58) address.",
                },
                price: { type: "number", description: "Quoted price in USD-equivalent, if checking fairness" },
              },
              required: ["merchant_wallet_address"],
            },
            output: { example: SAMPLE_CHECK_MERCHANT_OUTPUT },
          }),
        },
      };
      const httpServer = new x402HTTPResourceServer(resourceServer, routes);
      await httpServer.initialize();
      return httpServer;
    })();
  }
  return httpServerPromise;
}

/** GET /check?merchant_wallet_address=...&price=...&network=...&asset=...&amount=...&service_url=... */
export async function handleCheckGet(request: Request, env: Env, resourceServer: x402ResourceServer): Promise<Response> {
  const url = new URL(request.url);
  const merchantWalletAddress = url.searchParams.get("merchant_wallet_address");
  if (!merchantWalletAddress) {
    return new Response(JSON.stringify({ error: "merchant_wallet_address query parameter is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const httpServer = await getHttpResourceServer(env, resourceServer);
  const adapter = new FetchRequestAdapter(request);
  // v2 protocol header is PAYMENT-SIGNATURE; X-PAYMENT is the v1/legacy
  // header some older clients still send — accept either, same tolerance
  // @x402/mcp already gives MCP callers on the /mcp path.
  const paymentHeader = request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT") ?? undefined;

  const result = await httpServer.processHTTPRequest({
    adapter,
    path: "/check",
    method: "GET",
    paymentHeader,
    routePattern: "GET /check",
  });

  if (result.type === "payment-error") {
    return new Response(JSON.stringify(result.response.body), {
      status: result.response.status,
      headers: result.response.headers,
    });
  }
  if (result.type === "no-payment-required") {
    // The route above always declares `accepts`, so this shouldn't be
    // reachable — a defensive guard against a payment config that got
    // silently dropped, not an expected path.
    return new Response(JSON.stringify({ error: "Payment configuration error: no payment requirements resolved" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // result.type === "payment-verified" — run the same scoring logic and
  // build the same input shape check_merchant's MCP handler does.
  const startedAt = Date.now();
  const priceParam = url.searchParams.get("price");
  const input: CheckMerchantInput = {
    merchant_wallet_address: merchantWalletAddress,
    price: priceParam ? Number(priceParam) : undefined,
    network: url.searchParams.get("network") ?? undefined,
    asset: url.searchParams.get("asset") ?? undefined,
    amount: url.searchParams.get("amount") ?? undefined,
    service_url: url.searchParams.get("service_url") ?? undefined,
  };
  const output = await checkMerchant(env, input);

  const settlement = await httpServer.processSettlement(
    result.paymentPayload,
    result.paymentRequirements,
    result.declaredExtensions,
    undefined,
    undefined,
    result.beforeHandlerSettlement,
  );

  if (!settlement.success) {
    return new Response(JSON.stringify(settlement.response.body), {
      status: settlement.response.status,
      headers: settlement.response.headers,
    });
  }

  // Same query_log write as the MCP path's onAfterSettlement hook
  // (src/index.ts) — this GET path should be just as visible in
  // /metrics and /admin/callers as an MCP call, not a second, invisible
  // revenue path.
  await logQuery(env, {
    queriedWallet: merchantWalletAddress,
    payerAddress: settlement.payer ?? null,
    txHash: settlement.transaction ?? null,
    tierReturned: output.trust_tier ?? "settled",
    recommendation: output.recommendation ?? null,
    latencyMs: Date.now() - startedAt,
    queriedCategory: output.category ?? null,
    callerSuppliedPriceAtomic: input.price !== undefined ? Math.round(input.price * 1_000_000) : null,
  });

  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { "Content-Type": "application/json", ...settlement.headers },
  });
}
