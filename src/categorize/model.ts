import { tracing } from "cloudflare:workers";
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
  // Cloudflare agent tracing (2026-08-19) — the one genuine LLM call in
  // this codebase, so the one place a `chat` span (per the OTel GenAI
  // convention the tracing doc defers to) is a clean, unambiguous fit,
  // unlike check_merchant's `execute_tool` span (src/tool.ts), which
  // required more judgment since this Worker isn't itself an agent.
  // Nested under an `invoke_agent` span for the same reason documented on
  // check_merchant's version — the dashboard's Agents/Sessions/Runs/Tokens
  // rollup specifically counts `invoke_agent` spans carrying
  // gen_ai.agent.*/conversation.id, a bare `chat` span alone never
  // populates it. Each classification call is its own one-turn "session".
  // Attributes are usage/outcome metadata only — the listing description
  // and model output text are never attached to the span, same
  // metadata-only default applied to check_merchant's span.
  return tracing.enterSpan("invoke_agent", async (turnSpan) => {
    turnSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "merchant-check-mcp-categorizer",
      "gen_ai.agent.id": "categorize_by_model",
      "gen_ai.conversation.id": crypto.randomUUID(),
    });
    return tracing.enterSpan("chat", async (span) => {
      span.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": MODEL,
        "gen_ai.system": "anthropic",
      });
      const result = await categorizeByModelImpl(description, env);
      span.setAttributes({
        "categorize.outcome": result.category ? "classified" : result.unparseable ? "unparseable" : "call_failed",
      });
      return result;
    });
  });
}

async function categorizeByModelImpl(
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
