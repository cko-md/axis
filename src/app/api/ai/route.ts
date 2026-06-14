import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

type CaptureResult = { label: string; action: string; priority: "hi" | "med" | "lo" };
type TriageResult = { title: string; priority: "hi" | "med" | "lo"; category: string; effort: string };
type RouteResult = {
  destination: "research" | "literature" | "task";
  label: string;
  reason: string;
  tags: string[];
};

// Strip HTML tags so heuristics + the model see clean prose.
function stripHtml(s: string): string {
  return s
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function heuristicRoute(title: string, body?: string): RouteResult {
  const text = stripHtml(`${title}\n${body ?? ""}`);
  const lower = text.toLowerCase();
  const tags: string[] = [];
  if (/\bdoi\b|et al\.?|\bpubmed\b|\bcitation\b|\bpaper\b|\bpreprint\b|\babstract\b|\bjournal\b|references?\b/.test(lower)) {
    tags.push("citation");
  }
  if (/hypothesis|mechanism|aim \d|method|experiment|results?\b|figure \d|protocol/.test(lower)) tags.push("research");
  if (/\btodo\b|\[ \]|follow[- ]?up|deadline|submit|email |schedule|remind|by (mon|tue|wed|thu|fri|next|tomorrow)/.test(lower)) {
    tags.push("actionable");
  }

  // Decide destination from the strongest signal.
  let destination: RouteResult["destination"] = "research";
  let label = "Research workspace";
  let reason = "Reads like working notes — keeping it in your research space.";

  if (tags.includes("actionable") && !tags.includes("citation")) {
    destination = "task";
    label = "New task";
    const firstLine = text.split("\n").find((l) => l.trim().length > 0)?.trim().slice(0, 80) || title;
    reason = `Contains an action — turn “${firstLine}” into a tracked task.`;
  } else if (tags.includes("citation")) {
    destination = "literature";
    label = "Literature library";
    reason = "Mentions references/citations — file under your Literature library.";
  }
  return { destination, label, reason, tags: tags.length ? tags : ["note"] };
}

export const runtime = "nodejs";

// Heuristic fallbacks — used when ANTHROPIC_API_KEY is absent
function heuristicCapture(text: string): CaptureResult {
  const lower = text.toLowerCase();
  let priority: "hi" | "med" | "lo" = "med";
  if (/urgent|asap|critical|sign now/.test(lower)) priority = "hi";
  if (/fyi|low|whenever|someday/.test(lower)) priority = "lo";
  const label = priority === "hi" ? "Urgent" : priority === "lo" ? "Reference" : "Action";
  const action = `Add to ${priority === "lo" ? "reference" : "agenda"}`;
  return { label, action, priority };
}

function heuristicTriage(title: string, body?: string): TriageResult {
  const lower = `${title} ${body ?? ""}`.toLowerCase();
  let priority: "hi" | "med" | "lo" = "med";
  if (/urgent|asap|high|critical|sign/.test(lower)) priority = "hi";
  if (/fyi|low|whenever/.test(lower)) priority = "lo";
  let category = "research";
  if (/clinical|patient|bls|cert/.test(lower)) category = "clinical";
  if (/meal|tailor|family/.test(lower)) category = "life";
  if (/personal|birthday/.test(lower)) category = "personal";
  let effort = "~1h";
  if (/quick|5 min|15 min/.test(lower)) effort = "~15m";
  if (/deep|2h|90/.test(lower)) effort = "~2h";
  return { title, priority, category, effort };
}

type RegimenItem = {
  name: string;
  sets?: number;
  reps?: string;
  weight?: string;
  rest?: string;
  zone?: string;
  dist?: string;
  pace?: string;
};
type RegimenResult = { warmup?: string; items: RegimenItem[]; cooldown?: string };
type RegimenPlanDay = { dow: number; title: string; kind: string; duration_min: number; intensity: string; items: RegimenItem[]; notes?: string };
type RegimenPlanResult = { days: RegimenPlanDay[]; summary: string };

function fallbackRegimen(kind: string, duration: number, intensity: string): RegimenResult {
  if (kind === "run") {
    if (intensity === "easy") return { warmup: "5 min easy walk/jog", items: [{ name: "Easy run", dist: `${Math.round(duration * 0.16 * 10)/10} km`, zone: "Z1-2" }], cooldown: "5 min walk + stretch" };
    if (intensity === "hard") return { warmup: "10 min easy + 4 strides", items: [{ name: "Warm-up jog", dist: "2 km", zone: "Z2" }, { name: "Intervals", reps: "6", dist: "800m", zone: "Z4-5", rest: "90s" }, { name: "Cool-down jog", dist: "2 km", zone: "Z1-2" }], cooldown: "5 min walk + stretching" };
    return { warmup: "5 min easy", items: [{ name: "Tempo run", dist: `${Math.round(duration * 0.15 * 10)/10} km`, zone: "Z3-4" }], cooldown: "5 min easy" };
  }
  if (kind === "lift") return { warmup: "5 min cardio + joint mobility", items: [{ name: "Compound A", sets: 4, reps: "5-8", rest: "3 min" }, { name: "Compound B", sets: 3, reps: "8-12", rest: "2 min" }, { name: "Accessory A", sets: 3, reps: "12-15", rest: "60s" }, { name: "Accessory B", sets: 3, reps: "15-20", rest: "60s" }], cooldown: "Foam roll + static stretch" };
  return { items: [{ name: "Session", dist: `${duration} min` }] };
}

export async function POST(req: NextRequest) {
  const { mode, text, body } = (await req.json()) as { mode: string; text: string; body?: string };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (mode === "triage") return NextResponse.json(heuristicTriage(text, body));
    if (mode === "route") return NextResponse.json(heuristicRoute(text, body));
    if (mode === "regimen") {
      const ctx = body ? JSON.parse(body) as { kind?: string; duration_min?: number; intensity?: string } : {};
      return NextResponse.json(fallbackRegimen(ctx.kind ?? "other", ctx.duration_min ?? 45, ctx.intensity ?? "moderate"));
    }
    if (mode === "regimenPlan") {
      const fallbackDays: RegimenPlanDay[] = [
        { dow: 0, title: "Easy Run", kind: "run", duration_min: 45, intensity: "easy", notes: "6 km · Z2", items: [{ name: "Easy run", dist: "6 km", zone: "Z1-2" }] },
        { dow: 1, title: "Strength — Lower", kind: "lift", duration_min: 45, intensity: "key", items: [{ name: "Romanian Deadlift", sets: 4, reps: "6-8" }, { name: "Bulgarian Split Squat", sets: 3, reps: "10" }] },
        { dow: 2, title: "Rest", kind: "rest", duration_min: 0, intensity: "easy", items: [] },
        { dow: 3, title: "Tempo Run", kind: "run", duration_min: 50, intensity: "hard", notes: "8 km · Z3-4", items: [{ name: "Warm-up jog", dist: "2 km", zone: "Z2" }, { name: "Tempo", dist: "6 km", zone: "Z3-4" }] },
        { dow: 4, title: "Mobility / Yoga", kind: "mobility", duration_min: 30, intensity: "easy", items: [{ name: "Hip flexor flow" }, { name: "Spinal rotation" }] },
        { dow: 5, title: "Long Run", kind: "run", duration_min: 110, intensity: "key", notes: "18 km · Z2", items: [{ name: "Long easy run", dist: "18 km", zone: "Z2" }] },
        { dow: 6, title: "Rest", kind: "rest", duration_min: 0, intensity: "easy", items: [] },
      ];
      return NextResponse.json({ days: fallbackDays, summary: "A balanced 4-day running week targeting sub-1:30. Add quality sessions progressively and monitor recovery." } as RegimenPlanResult);
    }
    return NextResponse.json(heuristicCapture(text));
  }

  const client = new Anthropic({ apiKey });

  try {
    if (mode === "regimen") {
      const ctx = body ? JSON.parse(body) as { kind?: string; duration_min?: number; intensity?: string; notes?: string } : {};
      const kind = ctx.kind ?? "other";
      const duration = ctx.duration_min ?? 45;
      const intensity = ctx.intensity ?? "moderate";
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: `You are an elite personal trainer and running coach. Given a workout session spec, return ONLY a JSON object with keys: warmup (string or null), items (array of exercise objects), cooldown (string or null). Each item has: name (string), and as relevant: sets (number), reps (string like "8-12"), weight (string like "RPE 8" or "BW"), rest (string like "90s"), zone (string like "Z2" or "Z4-5"), dist (string like "6 km"), pace (string like "4:45/km"). Return no more than 8 items. No markdown.`,
        messages: [{ role: "user", content: `kind: ${kind}\nduration: ${duration} min\nintensity: ${intensity}\ntitle: ${text}\nnotes: ${ctx.notes ?? "none"}` }],
      });
      const raw = (msg.content[0] as { type: string; text: string }).text.trim();
      return NextResponse.json(JSON.parse(raw) as RegimenResult);
    }

    if (mode === "regimenPlan") {
      const ctx = body ? JSON.parse(body) as { discipline?: string; weeksPerPlan?: number; daysPerWeek?: number; currentLevel?: string; goal?: string; stravaContext?: string } : {};
      const stravaSection = ctx.stravaContext
        ? `\n\nIMPORTANT — adapt the plan to this athlete's real data:\n${ctx.stravaContext}`
        : "";
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1400,
        system: `You are an elite ${ctx.discipline === "run" ? "running" : "strength & conditioning"} coach. Design a structured weekly training plan. Return ONLY a JSON object with keys: days (array), summary (string, 1-2 sentences). Each day object has: dow (0=Mon to 6=Sun), title (string), kind (run|lift|mobility|rest|other), duration_min (number), intensity (easy|moderate|hard|key), notes (string), items (array of exercises, same format as a single session). Include rest days. No markdown.`,
        messages: [{ role: "user", content: `discipline: ${ctx.discipline ?? "general"}\ndays per week: ${ctx.daysPerWeek ?? 4}\ncurrent level: ${ctx.currentLevel ?? "intermediate"}\ngoal: ${ctx.goal ?? "general fitness"}${stravaSection}` }],
      });
      const raw = (msg.content[0] as { type: string; text: string }).text.trim();
      return NextResponse.json(JSON.parse(raw) as RegimenPlanResult);
    }

    if (mode === "route") {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system:
          'You route a research note to the right destination in a personal knowledge OS. Given a note title and body, return ONLY a JSON object with keys: destination ("research" = working research notes, "literature" = a referenced paper/citation to file in the literature library, "task" = an actionable to-do), label (short human destination name, e.g. "New task" or "Literature library"), reason (one sentence, max 22 words, explaining the choice), tags (array of 1-4 short lowercase keywords). No markdown, no explanation.',
        messages: [{ role: "user", content: `title: ${text}\nbody: ${stripHtml(body ?? "").slice(0, 4000)}` }],
      });
      const raw = (msg.content[0] as { type: string; text: string }).text.trim();
      const parsed = JSON.parse(raw) as RouteResult;
      return NextResponse.json(parsed);
    }

    if (mode === "triage") {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system:
          'You are a task router for a personal OS. Given a signal title and optional body, return ONLY a JSON object with keys: title (string, cleaned up), priority ("hi"|"med"|"lo"), category ("clinical"|"research"|"life"|"personal"|"admin"), effort ("~15m"|"~1h"|"~2h"|"~3h+"). No markdown, no explanation.',
        messages: [{ role: "user", content: `title: ${text}\nbody: ${body ?? ""}` }],
      });
      const raw = (msg.content[0] as { type: string; text: string }).text.trim();
      const parsed = JSON.parse(raw) as TriageResult;
      return NextResponse.json(parsed);
    }

    // mode === "capture"
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system:
        'You are an intelligent personal assistant. Classify this captured thought. Return ONLY a JSON object with keys: label (1-3 words), action (imperative phrase, max 8 words), priority ("hi"|"med"|"lo"). No markdown, no explanation.',
      messages: [{ role: "user", content: text }],
    });
    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    const parsed = JSON.parse(raw) as CaptureResult;
    return NextResponse.json(parsed);
  } catch {
    if (mode === "triage") return NextResponse.json(heuristicTriage(text, body));
    if (mode === "route") return NextResponse.json(heuristicRoute(text, body));
    if (mode === "regimen") {
      const ctx = body ? JSON.parse(body) as { kind?: string; duration_min?: number; intensity?: string } : {};
      return NextResponse.json(fallbackRegimen(ctx.kind ?? "other", ctx.duration_min ?? 45, ctx.intensity ?? "moderate"));
    }
    if (mode === "regimenPlan") {
      return NextResponse.json({ days: [], summary: "Could not generate plan — check your API key and try again." } as RegimenPlanResult);
    }
    return NextResponse.json(heuristicCapture(text));
  }
}
