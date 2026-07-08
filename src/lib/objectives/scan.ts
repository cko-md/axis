import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { aiJSON, type AIProviderPref } from "@/lib/ai/router";
import { optionalEnv } from "@/lib/env";
import { buildObjectivesScanContext } from "@/lib/ai/platformScanContext";

export type ObjectiveSuggestion = {
  target: string;
  module: string;
  confidence: "high" | "medium" | "low";
};

export type ObjectivesScanResult = {
  results: ObjectiveSuggestion[];
  error?: string;
};

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * Shared core for the "Scan for objectives" feature: reads the user's recent
 * tasks/notes/signals, asks the AI for 3-5 high-level objectives, and returns
 * the suggestions for the caller to render. Does NOT write anything — these
 * are surfaced to the UI for the user to act on, not auto-inserted anywhere.
 */
export async function scanForObjectives(
  userId: string,
  supabase: SupabaseClient,
): Promise<ObjectivesScanResult> {
  const [tasksResult, notesResult, signalsResult] = await Promise.all([
    supabase.from("tasks").select("title, priority, deadline, status").eq("user_id", userId).neq("status", "done").limit(30),
    supabase.from("notes").select("title, body").eq("user_id", userId).order("updated_at", { ascending: false }).limit(20),
    supabase.from("signals").select("title, signal_type").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
  ]);
  if (tasksResult.error || notesResult.error || signalsResult.error) {
    return { results: [], error: "Could not load platform data for scan." };
  }

  const lines = buildObjectivesScanContext({
    tasks: tasksResult.data,
    notes: notesResult.data,
    signals: signalsResult.data,
  });

  if (!lines) return { results: [], error: "Not enough recent activity to scan." };

  const { data: profile } = await supabase.from("profiles").select("ai_provider").eq("id", userId).maybeSingle();
  const providerPref = ((profile as { ai_provider?: AIProviderPref } | null)?.ai_provider) ?? "gemini";

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  try {
    const result = await aiJSON<{ results: ObjectiveSuggestion[] }>({
      mode: "objectives-scan",
      anthropic,
      providerPref,
      system: 'Analyze this platform content and identify 3-5 high-level objectives the user should be working toward. Return ONLY a JSON object with key "results": an array of objects, each {target, module, confidence} where confidence is "high", "medium", or "low" and module is where you found the signal. No markdown, no preamble.',
      userMessage: lines,
      maxTokens: 600,
    });
    const results = Array.isArray(result.results) ? result.results : [];
    return {
      results: results
        .filter((r) => r && typeof r.target === "string" && r.target.trim())
        .map((r) => ({
          target: r.target,
          module: typeof r.module === "string" ? r.module : "platform",
          confidence: VALID_CONFIDENCE.has(r.confidence) ? r.confidence : "medium",
        })),
    };
  } catch {
    return { results: [], error: "AI scan is unavailable right now. Try again shortly." };
  }
}
