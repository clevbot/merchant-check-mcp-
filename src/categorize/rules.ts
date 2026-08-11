import type { MerchantCategory } from "./types";

/**
 * Pass 1: keyword matching. Deliberately conservative about "confident":
 * a description only gets ruled here if exactly one category's keyword set
 * matches. Zero matches or matches across multiple categories both fall
 * through to the model (pass 2) rather than guessing via priority order —
 * see categorizeByRules below.
 *
 * Phrases are chosen to avoid the obvious overlaps rather than resolved by
 * ordering: e.g. bare "price" isn't a keyword anywhere (too ambiguous
 * between data_api's raw feeds and financial_data's market analytics);
 * "price feed" is data_api per the spec's own example, "market cap" /
 * "trading signal" etc. are financial_data. Expect to tune these once
 * category_review_log shows real misses — they're a starting point, not
 * a final answer.
 */
const KEYWORDS: Record<Exclude<MerchantCategory, "other">, string[]> = {
  data_api: [
    "weather",
    "price feed",
    "block number",
    "block height",
    "blockheight",
    "eth_blocknumber",
    "balance",
    "ens",
    "forecast",
    "geolocation",
    "ip lookup",
    "dns lookup",
    "whois",
    "real-time data",
    "realtime data",
    "chain data",
    "on-chain data",
    "onchain data",
    "gas price",
    "mempool",
    "nft metadata",
    "domain lookup",
    "address lookup",
    "transaction lookup",
    "currency conversion",
    "exchange rate",
    "sports score",
    "news feed",
    "search api",
    "faucet",
  ],
  compute: [
    "gpu",
    "inference",
    "compute",
    "render farm",
    "rendering",
    "training job",
    "fine-tune",
    "fine tune",
    "batch job",
    "execute code",
    "code execution",
    "code sandbox",
    "serverless function",
    "model hosting",
    "transcode",
    "transcoding",
    "ml inference",
    "llm inference",
    "embedding generation",
    "vector embedding",
  ],
  content_generation: [
    "image generation",
    "generate image",
    "text-to-image",
    "text to image",
    "text-to-speech",
    "text to speech",
    " tts",
    "video generation",
    "generate video",
    "write article",
    "summarize",
    "summarization",
    "translate",
    "translation",
    "transcription",
    "transcribe",
    "voice synthesis",
    "music generation",
    "art generation",
    "generate content",
    "caption generation",
    "copywriting",
    "content creation",
  ],
  financial_data: [
    "stock price",
    "stock quote",
    "market cap",
    "trading signal",
    "trading strategy",
    "portfolio",
    "forex",
    "sec filing",
    "earnings report",
    "financial statement",
    "options data",
    "dividend",
    "defi analytics",
    "backtest",
    " apy",
    " apr ",
    "yield farming",
    "market data",
  ],
  storage: [
    "file storage",
    "ipfs",
    "pin file",
    "pinning",
    "backup",
    "archive",
    "store data",
    "persist data",
    "database hosting",
    "object storage",
    "cdn",
    "static hosting",
    "file hosting",
    "upload file",
  ],
};

/**
 * Returns a confident rule-based category, or null if the rule pass can't
 * confidently place it (zero or multiple category matches) — the caller
 * should fall through to the model in that case.
 */
export function categorizeByRules(text: string): MerchantCategory | null {
  const haystack = ` ${text.toLowerCase()} `;
  const matched: MerchantCategory[] = [];

  for (const [category, keywords] of Object.entries(KEYWORDS) as [
    Exclude<MerchantCategory, "other">,
    string[],
  ][]) {
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      matched.push(category);
    }
  }

  return matched.length === 1 ? matched[0]! : null;
}
