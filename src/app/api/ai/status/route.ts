import { NextResponse } from "next/server";
import { getGeminiApiKey, optionalEnv } from "@/lib/env";

/**
 * AI (Anthropic) connectivity status. Mirrors /api/massive/status and
 * /api/plaid/status: returns a clean setup-state with no error when
 * ANTHROPIC_API_KEY is unset, so Control Room can render the difference
 * between model-backed classification and the heuristic fallback. The key
 * itself is never returned — only whether it is configured.
 */
export async function GET() {
  const anthropicConfigured = !!optionalEnv("ANTHROPIC_API_KEY");
  const geminiConfigured = !!getGeminiApiKey();
  const configured = anthropicConfigured || geminiConfigured;
  return NextResponse.json({
    configured,
    mode: configured ? "model" : "heuristic",
    providers: {
      anthropic: anthropicConfigured,
      gemini: geminiConfigured,
    },
    message: configured
      ? "At least one AI provider is configured server-side. Capture and triage can run on a model."
      : "No ANTHROPIC_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY set — capture classification and signal triage use built-in heuristic fallbacks.",
  });
}
