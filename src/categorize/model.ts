import { CATEGORIES, isMerchantCategory, type MerchantCategory } from "./types";
import type { Env } from "../types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001"; // Haiku-class, per requirement 4
const ANTHROPIC_VERSION = "2023-06-01";

export interface ModelClassification {
  /** null when the call failed outright (no key, network error, non-2xx) — distinct from a parseable-but-wrong answer. */
  category: MerchantCategory | null;
  rawOutput: string | null;
  /** True when the API call succeeded but the response text wasn't one of the six category strings. */
  unparseable: boolean;
}

/**
 * Pass 2: model fallback for descriptions the rule pass (src/categorize/rules.ts)
 * couldn't confidently place. Never trusts the response blindly — output is
 * checked against the fixed CATEGORIES list before use; anything else is
 * treated as unparseable and the caller buckets it as 'other' + logs it
 * (see src/categorize/index.ts), same as requirement 2 asks for any
 * not-confidently-classified description.
 */
export async function categorizeByModel(
  description: string,
  env: Env,
): Promise<ModelClassification> {
  if (!env.ANTHROPIC_API_KEY) {
    return { category: null, rawOutput: null, unparseable: false };
  }

  const prompt =
    `Classify this x402 API/service listing into exactly one category from this fixed list: ` +
    `${CATEGORIES.join(", ")}.\n\n` +
    `Listing description: "${description.slice(0, 500)}"\n\n` +
    `Reply with ONLY the category string from the list above, nothing else. If none fit well, reply "other".`;

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { category: null, rawOutput: null, unparseable: false };
  }

  if (!res.ok) {
    return { category: null, rawOutput: null, unparseable: false };
  }

  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const rawOutput = body.content?.find((c) => c.type === "text")?.text ?? "";
  const cleaned = rawOutput.trim().toLowerCase();

  if (isMerchantCategory(cleaned)) {
    return { category: cleaned, rawOutput, unparseable: false };
  }
  return { category: null, rawOutput, unparseable: true };
}
