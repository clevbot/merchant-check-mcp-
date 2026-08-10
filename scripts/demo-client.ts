#!/usr/bin/env tsx
/**
 * End-to-end demo/test client: connects to the deployed merchant-check-mcp
 * server, lists tools (free), then calls check_merchant against the two
 * synthetic demo wallets seeded into D1 — paying for each call via x402 on
 * Base Sepolia with the throwaway payer key in .env.demo.
 *
 * Usage: npm run demo
 * Requires .env.demo (gitignored) with DEMO_PAYER_PRIVATE_KEY funded with
 * Base Sepolia test USDC + test ETH for gas.
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient, type PaymentRequestedContext, type MCPContentItem } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const MCP_URL = process.env.MCP_URL ?? "https://mcp.gradientdecisions.com/mcp";
const PAYER_KEY = process.env.DEMO_PAYER_PRIVATE_KEY;

if (!PAYER_KEY) {
  console.error("DEMO_PAYER_PRIVATE_KEY not set — run with: node --env-file=.env.demo ...");
  process.exit(1);
}

const account = privateKeyToAccount(PAYER_KEY as `0x${string}`);

async function main() {
  console.log(`Connecting to ${MCP_URL} as payer ${account.address}\n`);

  const x402Client = createx402MCPClient({
    name: "merchant-check-demo",
    version: "0.1.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
    autoPayment: true,
    onPaymentRequested: async ({ paymentRequired }: PaymentRequestedContext) => {
      const req = paymentRequired.accepts[0];
      console.log(
        `  → payment requested: ${req?.amount} atomic units of ${req?.asset} to ${req?.payTo}`,
      );
      return true;
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await x402Client.connect(transport);

  const tools = await x402Client.listTools();
  console.log(
    "tools/list (free, no payment):",
    tools.tools.map((t: { name: string }) => t.name),
    "\n",
  );

  const demoWallets = [
    { label: "seeded 'trusted' demo wallet", address: "0x11111111111111111111111111111111111111d1" },
    { label: "seeded 'avoid' demo wallet", address: "0x22222222222222222222222222222222222222d2" },
    { label: "unseen wallet (no history)", address: "0x99999999999999999999999999999999999999d9" },
  ];

  for (const { label, address } of demoWallets) {
    console.log(`--- check_merchant: ${label} (${address}) ---`);
    const result = await x402Client.callTool("check_merchant", { merchant_wallet_address: address });
    const text = (result.content as MCPContentItem[]).find(
      (c): c is MCPContentItem & { text: string } => c.type === "text" && typeof c.text === "string",
    )?.text;
    console.log("  result:", text);
    if (result.paymentMade) {
      console.log("  paid: tx", result.paymentResponse?.transaction);
    }
    console.log();
  }

  await x402Client.close();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
