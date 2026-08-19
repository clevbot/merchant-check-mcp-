import type { Env } from "../types";
import { categorizeByRules } from "./rules";
import { categorizeByModel } from "./model";
import type { CategoryResult } from "./types";
import { detectAndNormalize } from "../chains";

/**
 * Categorizes one description through both passes. Never invents a
 * category outside the fixed set (src/categorize/types.ts) — every branch
 * either returns a rule match, a validated model match, or 'other' with a
 * reviewReason explaining why.
 */
export async function categorizeDescription(
  description: string,
  env: Env,
): Promise<CategoryResult> {
  const ruleMatch = categorizeByRules(description);
  if (ruleMatch) {
    return { category: ruleMatch, source: "rule", reviewReason: null, rawModelOutput: null };
  }

  const modelResult = await categorizeByModel(description, env);

  if (modelResult.category) {
    return {
      category: modelResult.category,
      source: "model",
      reviewReason: "model_classified", // requirement 5: log every pass-2 result, not just the 'other' ones
      rawModelOutput: modelResult.rawOutput,
    };
  }

  if (modelResult.unparseable) {
    return {
      category: "other",
      source: "model",
      reviewReason: "other_unparseable_model_output",
      rawModelOutput: modelResult.rawOutput,
    };
  }

  // Rule pass found nothing AND the model pass didn't run at all (no
  // ANTHROPIC_API_KEY yet, or the call failed) — still 'other', not a
  // silent guess, and still flagged. Source stays 'rule' since that's the
  // pass that actually produced this result; the model was never reached.
  return {
    category: "other",
    source: "rule",
    reviewReason: description ? "other_model_unavailable" : "other_no_rule_match",
    rawModelOutput: null,
  };
}

async function logReview(
  env: Env,
  walletAddress: string,
  description: string | null,
  result: CategoryResult,
): Promise<void> {
  if (!result.reviewReason) return;
  // walletAddress arrives here already chain-normalized by every real
  // caller (see categorizeAndStoreOne below) — detectAndNormalize is a
  // defensive re-normalize, not a bare .toLowerCase(), so a Solana wallet
  // stays case-correct instead of being silently corrupted (see src/chains.ts).
  const detected = detectAndNormalize(walletAddress);
  const normalizedWallet = detected ? detected.normalized : walletAddress;
  await env.DB.prepare(
    `INSERT INTO category_review_log
       (wallet_address, description_text, category, category_source, reason, raw_model_output, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      normalizedWallet,
      description,
      result.category,
      result.source,
      result.reviewReason,
      result.rawModelOutput,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

/**
 * Categorizes and writes the result for a single wallet, using text the
 * caller already has in hand — this is what the trust-signal refresh
 * (src/refresh/index.ts) calls inline for a wallet it's ingesting for the
 * first time (category IS NULL), so no extra Bazaar fetch or D1 read is
 * needed for that path. Returns the result so the caller (e.g. runRefresh,
 * writing category-bucketed price observations right after) has the
 * category immediately without a second D1 round trip.
 */
export async function categorizeAndStoreOne(
  env: Env,
  walletAddress: string,
  description: string | null,
): Promise<CategoryResult> {
  const result = await categorizeDescription(description ?? "", env);
  const now = Math.floor(Date.now() / 1000);

  // Same reasoning as logReview above — normalize per-chain, not a bare
  // .toLowerCase(), or this UPDATE's WHERE clause silently matches zero
  // rows for any Solana wallet.
  const detected = detectAndNormalize(walletAddress);
  const normalizedWallet = detected ? detected.normalized : walletAddress;

  await env.DB.prepare(
    `UPDATE merchant_signals
     SET category = ?, category_source = ?, category_updated_at = ?
     WHERE wallet_address = ?`,
  )
    .bind(result.category, result.source, now, normalizedWallet)
    .run();

  await logReview(env, walletAddress, description, result);
  return result;
}

export interface RunCategorizationOptions {
  /** Re-categorize every wallet, not just uncategorized ones (monthly cadence — see wrangler.toml cron). */
  force?: boolean;
  /** Cap per invocation so a large force run can't run past Workers execution limits — call again to continue. */
  limit?: number;
}

export interface RunCategorizationResult {
  processed: number;
  remaining: number;
}

const DEFAULT_LIMIT = 200;

/**
 * The decoupled categorization pass, per requirement 6: reads
 * bazaar_description straight from D1 (kept fresh by every trust-signal
 * refresh — see src/refresh/index.ts) rather than re-fetching Bazaar, so it
 * runs on its own cadence entirely independent of the 2-hour trust-signal
 * schedule. Two ways in: POST /refresh's sibling POST /categorize
 * (src/index.ts) for a manual run, or the separate monthly cron trigger
 * (wrangler.toml) with force=true.
 */
export async function runCategorization(
  env: Env,
  options: RunCategorizationOptions = {},
): Promise<RunCategorizationResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  // Captured before processing: for force mode, "remaining" counts rows
  // whose category_updated_at is still older than this — i.e. not yet
  // touched by *this* sweep. Without this, force mode's WHERE clause never
  // excludes already-categorized rows, so a naive post-loop recount would
  // just report the total every time regardless of progress (caught this
  // via a live 4-batch run where it misleadingly reported the same number
  // after every batch despite each one processing a different, real set of
  // rows — the processing was correct, only this count was wrong).
  const sweepStartedAt = Math.floor(Date.now() / 1000);

  const where = options.force
    ? "WHERE is_demo = 0 AND bazaar_description IS NOT NULL"
    : "WHERE is_demo = 0 AND bazaar_description IS NOT NULL AND category IS NULL";

  const { results: rows } = await env.DB.prepare(
    `SELECT wallet_address, bazaar_description FROM merchant_signals
     ${where}
     ORDER BY category_updated_at ASC NULLS FIRST
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ wallet_address: string; bazaar_description: string | null }>();

  for (const row of rows) {
    await categorizeAndStoreOne(env, row.wallet_address, row.bazaar_description);
  }

  const remainingWhere = options.force
    ? `${where} AND (category_updated_at IS NULL OR category_updated_at < ?)`
    : where; // non-force: category IS NULL already excludes anything this call just categorized

  const remainingQuery = env.DB.prepare(`SELECT COUNT(*) as n FROM merchant_signals ${remainingWhere}`);
  const { results: remainingRows } = await (options.force
    ? remainingQuery.bind(sweepStartedAt)
    : remainingQuery
  ).all<{ n: number }>();

  return { processed: rows.length, remaining: remainingRows[0]?.n ?? 0 };
}
