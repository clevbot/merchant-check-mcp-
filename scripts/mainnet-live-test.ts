#!/usr/bin/env tsx
/**
 * REAL MONEY. Base mainnet, real USDC, real settlement.
 *
 * Deliberately NOT wired into `npm run demo` or any other default command —
 * this only ever runs when explicitly invoked with `npm run mainnet-test`,
 * and only ever with a private key YOU provide via a local, gitignored
 * .env.mainnet-test file that never leaves your machine. See README
 * "Mainnet live payment test" for the full setup.
 *
 * This is a one-time manual confirmation that real settlement actually
 * works end to end, not a repeatable demo — each run spends real USDC.
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient, type PaymentRequestedContext } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const MCP_URL = process.env.MCP_URL ?? "https://mcp.gradientdecisions.com/mcp";
const PAYER_KEY = process.env.MAINNET_PAYER_PRIVATE_KEY;
// A real, trusted-tier merchant from the live dataset, for a meaningful result.
const TEST_WALLET = process.env.TEST_MERCHANT_WALLET ?? "0xffc458db291b4abce020fe3de4f91f2770e537b1";

if (!PAYER_KEY) {
  console.error(
    "MAINNET_PAYER_PRIVATE_KEY not set. Run with:\n" +
      "  node --env-file=.env.mainnet-test --import tsx scripts/mainnet-live-test.ts\n" +
      "See README \"Mainnet live payment test\" for how to set up .env.mainnet-test.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(PAYER_KEY as `0x${string}`);

async function main() {
  console.log(`⚠️  REAL MONEY TEST — Base mainnet, real USDC`);
  console.log(`Payer: ${account.address}`);
  console.log(`Target: ${MCP_URL}`);
  console.log(`Merchant being checked: ${TEST_WALLET}\n`);

  const x402Client = createx402MCPClient({
    name: "mainnet-live-test",
    version: "0.1.0",
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    autoPayment: true,
    onPaymentRequested: async ({ paymentRequired }: PaymentRequestedContext) => {
      const req = paymentRequired.accepts[0];
      console.log(`→ Real payment requested: ${req?.amount} atomic units of ${req?.asset} to ${req?.payTo}`);
      console.log(`  Proceeding automatically — you already confirmed this by running the script.\n`);
      return true;
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await x402Client.connect(transport);

  const result = await x402Client.callTool("check_merchant", { merchant_wallet_address: TEST_WALLET });
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text;

  console.log("Result:", text);
  if (result.paymentMade) {
    console.log("\n✅ Real settlement confirmed.");
    console.log("Transaction:", result.paymentResponse?.transaction);
    console.log(`View on BaseScan: https://basescan.org/tx/${result.paymentResponse?.transaction}`);
  } else {
    console.log("\n⚠️  No payment was made — check the result above for why.");
  }

  await x402Client.close();
}

main().catch((err) => {
  console.error("Live test failed:", err);
  process.exit(1);
});
