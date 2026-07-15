/**
 * Model cost estimation (program §11 cost visibility). The AI router returns
 * only { text, model } (no token usage), so cost is ESTIMATED from text length
 * and a per-model price table. Estimates, clearly labeled — enough to meter and
 * budget routine runs, not billing-grade.
 *
 * Pure and dependency-free so the estimation is unit-tested and reused wherever
 * an AI step records its cost.
 */

/** USD per 1M tokens, {input, output}. Approximate; update as pricing changes. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.8, output: 4 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  "gemini-flash": { input: 0.075, output: 0.3 },
  "gemini-pro": { input: 1.25, output: 5 },
};

const FALLBACK_PRICING = { input: 1, output: 5 };

/** Rough token estimate: ~4 characters per token (English text). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Map a router model string ("claude/haiku-4-5", "gemini/…") to a price key. */
export function pricingKeyForModel(model: string): keyof typeof MODEL_PRICING | null {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  if (m.includes("gemini")) return m.includes("pro") ? "gemini-pro" : "gemini-flash";
  return null;
}

/**
 * Estimate the USD cost of a generation from its input/output text and model.
 * Rounded to 6 decimals. Unknown models fall back to a conservative price.
 */
export function estimateCostUsd(model: string, inputText: string, outputText: string): number {
  const key = pricingKeyForModel(model);
  const price = (key && MODEL_PRICING[key]) || FALLBACK_PRICING;
  const inTokens = estimateTokens(inputText);
  const outTokens = estimateTokens(outputText);
  const usd = (inTokens / 1_000_000) * price.input + (outTokens / 1_000_000) * price.output;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
