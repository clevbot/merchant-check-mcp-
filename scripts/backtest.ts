#!/usr/bin/env tsx
/**
 * Validation step from the brief: "run the v1 scoring composite against a
 * small hand-labeled set of wallets ... before the endpoint goes live."
 *
 * Run AFTER the refresh worker has populated merchant_signals for the
 * wallets in scripts/labeled-wallets.json (POST /refresh, or wait for a
 * cron tick once attached). This does not call scoring logic directly — it
 * reads the same D1 rows check_merchant would read, via `wrangler d1
 * execute`, so it's testing what's actually stored, not a reimplementation.
 *
 * Usage:
 *   npm run backtest -- --remote   (default: --local)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

type Tier = "trusted" | "caution" | "avoid";
interface LabeledCase {
  wallet: string;
  expectedTier: Tier;
  note?: string;
}
interface LabeledSet {
  cases: LabeledCase[];
}

const remote = process.argv.includes("--remote");
const flag = remote ? "--remote" : "--local";

const labeled: LabeledSet = JSON.parse(
  readFileSync(new URL("./labeled-wallets.json", import.meta.url), "utf8"),
);

if (labeled.cases.length === 0) {
  console.error(
    "scripts/labeled-wallets.json has no cases — fill in known-legitimate (and, once a " +
      "real source exists, known-bad) wallet addresses before running the backtest. See " +
      "the file's _comment / _avoid_bucket fields for why 'avoid' is empty by default.",
  );
  process.exit(1);
}

function queryTier(wallet: string): string | null {
  const sql = `SELECT tier FROM merchant_signals WHERE wallet_address = '${wallet.toLowerCase()}';`;
  const out = execSync(`npx wrangler d1 execute merchant-signals ${flag} --json --command "${sql}"`, {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  const row = parsed?.[0]?.results?.[0];
  return row?.tier ?? null;
}

let mismatches = 0;

console.log(`Backtesting against ${flag} D1...\n`);
for (const { wallet, expectedTier, note } of labeled.cases) {
  const actual = queryTier(wallet);
  const ok = actual === expectedTier;
  if (!ok) mismatches++;
  console.log(
    `${ok ? "OK  " : "MISS"}  ${wallet}  expected=${expectedTier}  actual=${
      actual ?? "(no row — not yet indexed)"
    }${note ? `  # ${note}` : ""}`,
  );
}

console.log(`\n${mismatches} mismatch(es) out of ${labeled.cases.length}.`);
if (mismatches > 0) {
  console.log(
    "Do not flip the endpoint to charge for real queries until thresholds in " +
      "src/scoring.ts are adjusted and this passes cleanly.",
  );
  process.exit(1);
}
console.log(
  "\nNote: this only validates 'trusted' and 'caution' against real data — 'avoid' is " +
    "unvalidated (see labeled-wallets.json _avoid_bucket).",
);
