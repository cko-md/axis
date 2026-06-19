import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

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

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 700,
    messages: [{ role: "user", content: prompts[type] }],
  });

  try {
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found");
    const steps: RoutineStep[] = JSON.parse(match[0]);
    if (!Array.isArray(steps) || steps.length === 0) throw new Error("Empty array");
    // Ensure each step has the required shape
    const sanitized = steps.map((s) => ({
      id: String(s.id ?? crypto.randomUUID()),
      time: String(s.time ?? "—"),
      title: String(s.title ?? "").slice(0, 60),
      sub: String(s.sub ?? "").slice(0, 80),
    }));
    return NextResponse.json({ steps: sanitized });
  } catch {
    return NextResponse.json({ error: "AI_PARSE_FAILED" }, { status: 500 });
  }
}
