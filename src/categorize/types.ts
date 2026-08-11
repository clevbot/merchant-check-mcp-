/**
 * Fixed category set. Per the requirement: do not let this expand
 * dynamically — every consumer (rules, model prompt, schema, dashboard)
 * imports from here, so there's exactly one place that could ever add a
 * seventh value, and doing so is a deliberate code change, not something
 * a keyword list or a model response can trigger on its own.
 */
export const CATEGORIES = [
  "data_api",
  "compute",
  "content_generation",
  "financial_data",
  "storage",
  "other",
] as const;

export type MerchantCategory = (typeof CATEGORIES)[number];

export function isMerchantCategory(value: string): value is MerchantCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

export type CategorySource = "rule" | "model";

export interface CategoryResult {
  category: MerchantCategory;
  source: CategorySource;
  /** Set when this result is worth a human spot-check — see category_review_log. */
  reviewReason:
    | null
    | "model_classified"
    | "other_no_rule_match"
    | "other_model_unavailable"
    | "other_unparseable_model_output";
  /** Raw model response text, when a model call was made — kept for the review log. */
  rawModelOutput: string | null;
}
