import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { aiJSON, type AIProviderPref } from "@/lib/ai/router";

type SignalType = "action" | "awaiting" | "fyi";
const VALID_SIGNAL_TYPES: SignalType[] = ["action", "awaiting", "fyi"];

type ScannedSignal = { title: string; body?: string; signal_type?: string; source?: string };

/**
 * Shared core for "Scan modules" (Dispatch): reads the user's open tasks +
 * existing signal titles, asks the AI for up to 4 new signals worth surfacing,
 * and inserts the non-duplicate ones. Returns how many were created.
 *
 * Used by the on-demand /api/signals/scan route and the cron intelligence sweep.
 */
export async function scanPlatformForUser(
  userId: string,
  supabase: SupabaseClient,
): Promise<{ created: number }> {
  const [{ data: tasks }, { data: signals }, { data: profile }] = await Promise.all([
    supabase.from("tasks").select("title, priority, category, status, deadline").eq("user_id", userId).neq("status", "done").limit(15),
    supabase.from("signals").select("title").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
    supabase.from("profiles").select("ai_provider").eq("id", userId).maybeSingle(),
  ]);

  const existingTitles = (signals ?? []).map((s) => s.title as string);
  const taskCtx = (tasks ?? [])
    .map((t) => `[${String(t.priority).toUpperCase()}] ${t.title} (${t.category}, ${t.status}${t.deadline ? `, due ${t.deadline}` : ""})`)
    .join("\n");

  const providerPref = ((profile as { ai_provider?: AIProviderPref } | null)?.ai_provider) ?? "gemini";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  let items: ScannedSignal[] = [];
  try {
    const result = await aiJSON<{ signals: ScannedSignal[] }>({
      mode: "platform-scan",
      anthropic,
      providerPref,
      system: 'You are the Axis dispatch intelligence. Scan the given platform context and identify up to 4 signals that genuinely need attention, routing, or action. Do NOT duplicate signals already in the inbox. Return ONLY a JSON object with key "signals": an array of objects with keys: title (string, <60 chars), body (string, <120 chars), signal_type ("action"|"awaiting"|"fyi"), source (string). No markdown, no preamble.',
      userMessage: `Current tasks:\n${taskCtx || "No tasks."}\n\nAlready in inbox: ${existingTitles.slice(0, 20).join("; ") || "Empty"}`,
      maxTokens: 600,
    });
    const { _model: _, ...rest } = result;
    items = Array.isArray(rest.signals) ? rest.signals : [];
  } catch {
    // Graceful degrade — no new signals rather than throwing.
    return { created: 0 };
  }

  const existingLower = new Set(existingTitles.map((t) => t.toLowerCase()));
  let created = 0;
  for (const item of items.slice(0, 4)) {
    if (!item.title) continue;
    if (existingLower.has(item.title.toLowerCase())) continue;
    const type: SignalType = VALID_SIGNAL_TYPES.includes(item.signal_type as SignalType) ? (item.signal_type as SignalType) : "fyi";
    const { data, error } = await supabase
      .from("signals")
      .insert({
        user_id: userId,
        title: item.title,
        body: item.body ?? null,
        signal_type: type,
        source: item.source ?? "Platform Scan",
      })
      .select()
      .single();
    if (!error && data) {
      created += 1;
      existingLower.add(item.title.toLowerCase());
    }
  }

  return { created };
}
