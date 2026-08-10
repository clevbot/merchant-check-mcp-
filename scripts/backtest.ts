#!/usr/bin/env tsx
/**
 * Validation step from the brief: "run the v1 scoring composite against a
 * small hand-labeled set of wallets ... before the endpoint goes live."
 *
 * Run AFTER the refresh worker has populated merchant_signals for the
 * wallets in scripts/labeled-wallets.json (run it manually once first, or
 * wait for a cron tick). This does not call scoring logic directly — it
 * reads the same D1 rows check_merchant would read, via `wrangler d1
 * execute`, so it's testing what's actually stored, not a reimplementation.
 *
 * Usage:
 *   npm run backtest -- --remote   (default: --local)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface LabeledSet {
  trusted: string[];
  avoid: string[];
}

const remote = process.argv.includes("--remote");
const flag = remote ? "--remote" : "--local";

const labeled: LabeledSet = JSON.parse(
  readFileSync(new URL("./labeled-wallets.json", import.meta.url), "utf8"),
);

if (labeled.trusted.length === 0 && labeled.avoid.length === 0) {
  console.error(
    "scripts/labeled-wallets.json is empty — fill in known-legitimate and known-scam " +
      "wallet addresses before running the backtest. See the file's _comment field.",
  );
  process.exit(1);
}

function queryTier(wallet: string): string | null {
  const sql = `SELECT tier FROM merchant_signals WHERE wallet_address = '${wallet.toLowerCase()}';`;
  const out = execSync(
    `npx wrangler d1 execute merchant-signals ${flag} --json --command "${sql}"`,
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  const row = parsed?.[0]?.results?.[0];
  return row?.tier ?? null;
}

let mismatches = 0;

function check(wallet: string, expected: "trusted" | "avoid") {
  const actual = queryTier(wallet);
  const ok = actual === expected;
  if (!ok) mismatches++;
  console.log(
    `${ok ? "OK  " : "MISS"}  ${wallet}  expected=${expected}  actual=${actual ?? "(no row — not yet indexed)"}`,
  );
}

console.log(`Backtesting against ${flag} D1...\n`);
for (const wallet of labeled.trusted) check(wallet, "trusted");
for (const wallet of labeled.avoid) check(wallet, "avoid");

console.log(`\n${mismatches} mismatch(es) out of ${labeled.trusted.length + labeled.avoid.length}.`);
if (mismatches > 0) {
  console.log(
    "Do not flip the endpoint to charge for real queries until thresholds in " +
      "src/scoring.ts are adjusted and this passes cleanly.",
  );
  process.exit(1);
}
