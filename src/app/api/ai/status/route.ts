import { NextResponse } from "next/server";

/**
 * AI (Anthropic) connectivity status. Mirrors /api/massive/status and
 * /api/plaid/status: returns a clean setup-state with no error when
 * ANTHROPIC_API_KEY is unset, so Control Room can render the difference
 * between model-backed classification and the heuristic fallback. The key
 * itself is never returned — only whether it is configured.
 */
export async function GET() {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  return NextResponse.json({
    configured,
    mode: configured ? "model" : "heuristic",
    message: configured
      ? "Anthropic API key is configured server-side. Capture and triage run on the model."
      : "No ANTHROPIC_API_KEY set — capture classification and signal triage use the built-in heuristic fallback (no errors).",
  });
}
