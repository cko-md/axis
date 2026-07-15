import Anthropic from "@anthropic-ai/sdk";
import { optionalEnv } from "@/lib/env";
import { aiGenerate } from "./router";
import { estimateCostUsd } from "./cost";

/**
 * AI "explain" helper (§2.6, §11) — the sanctioned LLM-judgment use: turn an
 * already-computed, deterministic result into a plain-language explanation. The
 * model EXPLAINS; it never computes financial values. Returns the text plus an
 * estimated cost so callers can meter it, or `{ skipped: true }` when no model
 * is configured or the call fails (never throws — an explanation is optional).
 */
export type ExplainResult =
  | { skipped: true; reason: string }
  | { skipped: false; text: string; model: string; estimatedCostUsd: number };

export async function explainWithCost(args: {
  system: string;
  userMessage: string;
  maxTokens?: number;
  mode?: string;
}): Promise<ExplainResult> {
  const anthropicKey = optionalEnv("ANTHROPIC_API_KEY");
  const geminiConfigured = !!(optionalEnv("GEMINI_API_KEY") || optionalEnv("GOOGLE_GENERATIVE_AI_API_KEY"));
  if (!anthropicKey && !geminiConfigured) return { skipped: true, reason: "no_model_configured" };

  const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
  try {
    const { text, model } = await aiGenerate({
      mode: args.mode ?? "explain",
      system: args.system,
      userMessage: args.userMessage,
      maxTokens: args.maxTokens ?? 400,
      anthropic,
      providerPref: "auto",
    });
    return {
      skipped: false,
      text: text.trim(),
      model,
      estimatedCostUsd: estimateCostUsd(model, `${args.system}\n${args.userMessage}`, text),
    };
  } catch {
    return { skipped: true, reason: "generation_failed" };
  }
}
