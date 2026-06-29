import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiJSON, type AIProviderPref } from "@/lib/ai/router";

type RoutineStep = { id: string; time: string; title: string; sub: string };

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let type: "morning" | "night";
  let currentSteps: RoutineStep[];
  try {
    const body = await req.json();
    if (body.type !== "morning" && body.type !== "night") {
      return NextResponse.json({ error: "type must be morning or night" }, { status: 400 });
    }
    type = body.type;
    currentSteps = Array.isArray(body.currentSteps) ? body.currentSteps : [];
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("display_name")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: objectives } = await supabase
    .from("objectives")
    .select("title, category")
    .eq("user_id", user.id)
    .limit(5);

  const { data: profile } = await supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle();
  const providerPref = (profile?.ai_provider as AIProviderPref) ?? "gemini";

  const name = prefs?.display_name ?? "the user";
  const objectivesList =
    objectives && objectives.length > 0
      ? objectives.map((o) => `- ${o.title} (${o.category})`).join("\n")
      : "No objectives on file.";

  const currentList =
    currentSteps.length > 0
      ? currentSteps.map((s) => `${s.time} — ${s.title}`).join("\n")
      : "No existing steps.";

  const prompts: Record<"morning" | "night", string> = {
    morning: `You are an elite performance coach. Design an optimized morning routine for ${name} — a physician-researcher with goals in health, research, and financial independence.\n\nCurrent routine:\n${currentList}\n\nUser objectives:\n${objectivesList}\n\nReturn ONLY a JSON array of 6–8 steps with this exact shape: [{id,time,title,sub}] where id is a short unique string, time is "HH:MM" (starting 05:30–06:00), title is the step name (max 48 chars), sub is a brief rationale (max 60 chars). Science-backed, high-performance, realistic for a busy clinician. No preamble, no explanation — only the JSON array.`,
    night: `You are an elite sleep and recovery coach. Design an optimized night wind-down routine for ${name} — a physician-researcher who needs quality sleep for peak cognition.\n\nCurrent routine:\n${currentList}\n\nUser objectives:\n${objectivesList}\n\nReturn ONLY a JSON array of 6–8 steps with this exact shape: [{id,time,title,sub}] where id is a short unique string, time is "HH:MM" (starting 21:00–21:30), title is the step name (max 48 chars), sub is a brief rationale (max 60 chars). Prioritise sleep onset, stress reduction, and next-day prep. No preamble, no explanation — only the JSON array.`,
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  try {
    // aiJSON spreads the parsed JSON onto an object (`{...parsed, _model}`) — asking
    // for a bare array would corrupt it into {0:.., 1:.., _model}. Request a wrapper
    // object instead, matching every other aiJSON consumer in this codebase.
    const result = await aiJSON<{ steps: RoutineStep[] }>({
      mode: "agenda-rebuild",
      anthropic,
      providerPref,
      system: 'You are an elite performance/recovery coach for a physician-researcher. Return ONLY a JSON object with key "steps": an array of 6-8 routine step objects, each {id,time,title,sub} where id is a short unique string, time is "HH:MM", title is the step name (max 48 chars), sub is a brief rationale (max 60 chars). No markdown, no preamble.',
      userMessage: prompts[type],
      maxTokens: 700,
    });
    const { _model: _, ...rest } = result;
    const rawSteps = rest.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error("Empty or invalid steps array");
    const sanitized = rawSteps.map((s) => ({
      id: String(s.id ?? crypto.randomUUID()),
      time: String(s.time ?? "—"),
      title: String(s.title ?? "").slice(0, 60),
      sub: String(s.sub ?? "").slice(0, 80),
    }));
    return NextResponse.json({ steps: sanitized });
  } catch {
    // Graceful degrade: hand back whatever steps the client already had rather than a 500.
    return NextResponse.json({ steps: currentSteps });
  }
}
