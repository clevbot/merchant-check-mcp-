#!/usr/bin/env tsx
/**
 * REAL MONEY. Base mainnet, real USDC, real settlement.
 *
 * Same pattern and same safeguards as scripts/mainnet-live-test.ts (see
 * that file's own header comment) — only difference is this one exercises
 * the plain-HTTP GET /check path (src/httpCheckEndpoint.ts) instead of the
 * MCP tool, since that's genuinely new payment-plumbing code that hadn't
 * completed a real settlement yet. Reuses the same .env.mainnet-test
 * credential file and env var names as mainnet-live-test.ts — no new
 * secrets needed.
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const SITE_URL = process.env.SITE_URL ?? "https://gradientdecisions.com";
const PAYER_KEY = process.env.MAINNET_PAYER_PRIVATE_KEY;
const TEST_WALLET = process.env.TEST_MERCHANT_WALLET ?? "0xffc458db291b4abce020fe3de4f91f2770e537b1";

if (!PAYER_KEY) {
  console.error(
    "MAINNET_PAYER_PRIVATE_KEY not set. Run with:\n" +
      "  node --env-file=.env.mainnet-test --import tsx scripts/mainnet-http-check-test.ts\n" +
      "Same .env.mainnet-test used by mainnet-live-test.ts — see README \"Mainnet live payment test\".",
  );
  process.exit(1);
}

const account = privateKeyToAccount(PAYER_KEY as `0x${string}`);

async function main() {
  console.log(`⚠️  REAL MONEY TEST — GET /check, Base mainnet, real USDC`);
  console.log(`Payer: ${account.address}`);
  console.log(`Merchant being checked: ${TEST_WALLET}\n`);

  const url = `${SITE_URL}/check?merchant_wallet_address=${TEST_WALLET}`;

  const coreClient = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
  const client = new x402HTTPClient(coreClient);

  const firstResponse = await fetch(url);
  if (firstResponse.status !== 402) {
    console.error(`Expected 402, got ${firstResponse.status}. Body:`, await firstResponse.text());
    process.exit(1);
  }

  const paymentRequired = client.getPaymentRequiredResponse(
    (name) => firstResponse.headers.get(name),
    await firstResponse.json().catch(() => undefined),
  );
  const accept = paymentRequired.accepts[0];
  console.log(`→ Real payment requested: ${accept?.amount} atomic units of ${accept?.asset} to ${accept?.payTo}`);
  console.log(`  Proceeding automatically — you already confirmed this by running the script.\n`);

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload);

  const paidResponse = await fetch(url, { headers: paymentHeaders });
  const bodyText = await paidResponse.text();

  if (paidResponse.status !== 200) {
    console.error(`Paid retry failed: ${paidResponse.status}`, bodyText);
    process.exit(1);
  }

  console.log("Result:", bodyText);

  const settlement = client.getPaymentSettleResponse((name) => paidResponse.headers.get(name));
  if (settlement?.success) {
    console.log("\n✅ Real settlement confirmed.");
    console.log("Transaction:", settlement.transaction);
    console.log(`View on BaseScan: https://basescan.org/tx/${settlement.transaction}`);
  } else {
    console.log("\n⚠️  Settlement response missing or unsuccessful:", settlement);
  }
}

main().catch((err) => {
  console.error("Live test failed:", err);
  process.exit(1);
});
