import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { aiGenerate, aiJSON, type AIProviderPref } from "@/lib/ai/router";
import { createClient } from "@/lib/supabase/server";
import { memoryRateLimit } from "@/lib/ratelimit";

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

  let destination: RouteResult["destination"] = "research";
  let label = "Research workspace";
  let reason = "Reads like working notes — keeping it in your research space.";

  if (tags.includes("actionable") && !tags.includes("citation")) {
    destination = "task";
    label = "New task";
    const firstLine = text.split("\n").find((l) => l.trim().length > 0)?.trim().slice(0, 80) || title;
    reason = `Contains an action — turn "${firstLine}" into a tracked task.`;
  } else if (tags.includes("citation")) {
    destination = "literature";
    label = "Literature library";
    reason = "Mentions references/citations — file under your Literature library.";
  }
  return { destination, label, reason, tags: tags.length ? tags : ["note"] };
}

export const runtime = "nodejs";

// ── Heuristic fallbacks (no API key) ─────────────────────────────────────────

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

function fallbackDeckCards(context: string): Array<{ id: string; title: string; body: string; actionLabel?: string; actionPath?: string }> {
  const lower = context.toLowerCase();
  if (lower.includes("literature")) return [
    { id: "0", title: "Research feed ready", body: "Your active topics have new papers. Check for DBS and plasticity matches.", actionLabel: "View feed", actionPath: "/literature" },
    { id: "1", title: "Save for later", body: "Star articles to save them offline for reading during downtime.", actionLabel: "Open saved", actionPath: "/literature" },
  ];
  if (lower.includes("vitality")) return [
    { id: "0", title: "Training today", body: "Check your plan for today's session and log it after completion.", actionLabel: "View plan", actionPath: "/vitality" },
    { id: "1", title: "Recovery note", body: "Log your sleep and HRV to track recovery trends over time." },
  ];
  if (lower.includes("fund")) return [
    { id: "0", title: "Portfolio check", body: "Review your holdings and recent transactions to stay on top of allocations.", actionLabel: "Open fund", actionPath: "/fund" },
  ];
  if (lower.includes("briefing")) return [
    { id: "0", title: "Morning brief ready", body: "Star stories in the briefing to save them for later reading.", actionLabel: "Open briefing", actionPath: "/briefing" },
  ];
  return [
    { id: "0", title: "Good to go", body: "Connect your Anthropic API key to get live AI insights here." },
    { id: "1", title: "Your command center", body: "Review your tasks and dispatch to start the day with clarity.", actionLabel: "Command", actionPath: "/command" },
  ];
}

function heuristicMeetingSummary(text: string): { summary: string } {
  const bullets = text.split(/[.!?]+/).filter(Boolean).slice(0, 3).map((s) => s.trim()).filter(Boolean);
  const points = bullets.length ? bullets.join("\n- ") : "See transcript";
  return { summary: `## Meeting Summary\n\n**Key Points:**\n- ${points}\n\n**Action Items:**\n- Review transcript and add action items\n\n**Decisions Made:**\n- None identified` };
}

function fallbackRegimen(kind: string, duration: number, intensity: string): RegimenResult {
  if (kind === "run") {
    if (intensity === "easy") return { warmup: "5 min easy walk/jog", items: [{ name: "Easy run", dist: `${Math.round(duration * 0.16 * 10) / 10} km`, zone: "Z1-2" }], cooldown: "5 min walk + stretch" };
    if (intensity === "hard") return { warmup: "10 min easy + 4 strides", items: [{ name: "Warm-up jog", dist: "2 km", zone: "Z2" }, { name: "Intervals", reps: "6", dist: "800m", zone: "Z4-5", rest: "90s" }, { name: "Cool-down jog", dist: "2 km", zone: "Z1-2" }], cooldown: "5 min walk + stretching" };
    return { warmup: "5 min easy", items: [{ name: "Tempo run", dist: `${Math.round(duration * 0.15 * 10) / 10} km`, zone: "Z3-4" }], cooldown: "5 min easy" };
  }
  if (kind === "lift") return { warmup: "5 min cardio + joint mobility", items: [{ name: "Compound A", sets: 4, reps: "5-8", rest: "3 min" }, { name: "Compound B", sets: 3, reps: "8-12", rest: "2 min" }, { name: "Accessory A", sets: 3, reps: "12-15", rest: "60s" }, { name: "Accessory B", sets: 3, reps: "15-20", rest: "60s" }], cooldown: "Foam roll + static stretch" };
  return { items: [{ name: "Session", dist: `${duration} min` }] };
}

function heuristicNoteSummarize(text: string, title?: string): { summary: string } {
  const clean = stripHtml(text);
  const sentences = clean.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const bullets = sentences.map((s) => `- ${s}`).join("\n");
  return { summary: `${title ? `**${title}**\n\n` : ""}${bullets || "No content to summarize."}` };
}

function heuristicNoteRewrite(text: string): { rewritten: string } {
  return { rewritten: stripHtml(text).trim() };
}

function heuristicNoteTitle(text: string): { title: string } {
  const clean = stripHtml(text);
  const first = clean.split(/[\n.!?]/)[0]?.trim().slice(0, 80) ?? "Untitled";
  return { title: first || "Untitled" };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Rate limit: 30 requests per minute per user (Redis when available, memory fallback)
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(30, "1 m"),
      prefix: "axis:ai",
    });
    const { success } = await ratelimit.limit(user.id);
    if (!success) {
      return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
    }
  } else {
    const { success } = memoryRateLimit(`ai:${user.id}`, 30, 60_000);
    if (!success) {
      return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
    }
  }

  const { mode, text, body, title } = (await req.json()) as { mode: string; text: string; body?: string; title?: string };

  const { data: profile } = await supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle();
  const providerPref = (profile?.ai_provider as AIProviderPref) ?? "auto";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  // No AI keys at all → heuristics only
  if (!apiKey && !hasGemini) {
    if (mode === "notes-summarize") return NextResponse.json(heuristicNoteSummarize(text, title));
    if (mode === "notes-rewrite") return NextResponse.json(heuristicNoteRewrite(text));
    if (mode === "notes-title") return NextResponse.json(heuristicNoteTitle(text));
    if (mode === "meeting-summary") return NextResponse.json(heuristicMeetingSummary(text));
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
    if (mode === "companion") return NextResponse.json({ response: "I'm offline right now — check your connection and try again." });
    if (mode === "deck-insights") return NextResponse.json({ cards: fallbackDeckCards(text) });
    if (mode === "debrief_summary") return NextResponse.json({ summary: "Summary unavailable — API key required." });
    return NextResponse.json(heuristicCapture(text));
  }

  // Build Anthropic client only when key is available
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  try {
    // ── companion ──────────────────────────────────────────────────────────────
    if (mode === "companion") {
      const ctx = body ? JSON.parse(body) as { context?: string; history?: Array<{ role: string; content: string }>; persona?: string } : {};
      const rawContext = String(ctx.context ?? "").replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 1500);
      const context = rawContext ? `<context>${rawContext}</context>` : "";
      const history = (ctx.history ?? []).slice(-10).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const persona = ctx.persona ?? "axiom";

      const systemPrompt = persona === "nova"
        ? `You are Nova, a single-shot oracle embedded in Axis. ${context} Give one direct, precise answer. No lists, no follow-ups. Max 2 sentences. Never start with "I". Be oracular — distilled, final.`
        : `You are Axiom, the persistent intelligence layer in Axis — a personal operating system for a neuroscience physician-researcher. You hold the thread across the session: reference what was discussed, track open loops, surface what matters next. ${context} Respond with precision and strategic brevity. Avoid filler. When you give lists, keep them to 3 items. Never start your reply with "I". Stay contextually grounded.`;

      // "auto" keeps companion on Haiku (personality/context continuity) unless
      // the user explicitly forces Gemini or Anthropic via providerPref.
      const { text: response } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: systemPrompt,
        userMessage: text,
        conversationHistory: history,
        maxTokens: persona === "nova" ? 120 : 400,
      });
      return NextResponse.json({ response });
    }

    // ── deck-insights ──────────────────────────────────────────────────────────
    if (mode === "deck-insights") {
      const ctx = body ? JSON.parse(body) as { context?: string } : {};
      const context = String(ctx.context ?? "General module").replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 500);
      const raw = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: `You generate concise contextual intelligence cards for a personal OS. Given the current module and time of day, return ONLY a JSON array of 3–5 objects. Each has: title (string, ≤5 words), body (string, ≤22 words, specific and actionable), optionally: actionLabel (string, ≤3 words), actionPath (string, URL path like "/literature" or "/agenda"). Focus on what the user should pay attention to right now. No markdown, no preamble.`,
        userMessage: context,
        maxTokens: 500,
      });
      const cards = JSON.parse(raw.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()) as Array<{ title: string; body: string; actionLabel?: string; actionPath?: string }>;
      return NextResponse.json({ cards: cards.map((c, i) => ({ ...c, id: String(i) })) });
    }

    // ── regimen ────────────────────────────────────────────────────────────────
    if (mode === "regimen") {
      const ctx = body ? JSON.parse(body) as { kind?: string; duration_min?: number; intensity?: string; notes?: string } : {};
      const result = await aiJSON<RegimenResult>({
        mode,
        anthropic,
        providerPref,
        system: `You are an elite personal trainer and running coach. Given a workout session spec, return ONLY a JSON object with keys: warmup (string or null), items (array of exercise objects), cooldown (string or null). Each item has: name (string), and as relevant: sets (number), reps (string like "8-12"), weight (string like "RPE 8" or "BW"), rest (string like "90s"), zone (string like "Z2" or "Z4-5"), dist (string like "6 km"), pace (string like "4:45/km"). Return no more than 8 items. No markdown.`,
        userMessage: `kind: ${ctx.kind ?? "other"}\nduration: ${ctx.duration_min ?? 45} min\nintensity: ${ctx.intensity ?? "moderate"}\ntitle: ${text}\nnotes: ${ctx.notes ?? "none"}`,
        maxTokens: 600,
      });
      const { _model: _, ...regimenData } = result;
      return NextResponse.json(regimenData as RegimenResult);
    }

    // ── regimenPlan ────────────────────────────────────────────────────────────
    if (mode === "regimenPlan") {
      const ctx = body ? JSON.parse(body) as { discipline?: string; weeksPerPlan?: number; daysPerWeek?: number; currentLevel?: string; goal?: string; stravaContext?: string } : {};
      const stravaSection = ctx.stravaContext
        ? `\n\nIMPORTANT — adapt the plan based on the athlete data below.\n<strava_data>${String(ctx.stravaContext ?? "").replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 2000)}</strava_data>`
        : "";
      const result = await aiJSON<RegimenPlanResult>({
        mode,
        anthropic,
        providerPref,
        system: `You are an elite ${ctx.discipline === "run" ? "running" : ctx.discipline === "mobility" ? "mobility & Pilates" : "strength & conditioning"} coach. Design a structured weekly ${ctx.discipline === "mobility" ? "mobility/yoga/Pilates flow" : "training"} plan. Return ONLY a JSON object with keys: days (array), summary (string, 1-2 sentences). Each day object has: dow (0=Mon to 6=Sun), title (string), kind (run|lift|mobility|rest|other), duration_min (number), intensity (easy|moderate|hard|key), notes (string), items (array of exercises, same format as a single session). Include rest days. No markdown.`,
        userMessage: `discipline: ${ctx.discipline ?? "general"}\ndays per week: ${ctx.daysPerWeek ?? 4}\ncurrent level: ${ctx.currentLevel ?? "intermediate"}\ngoal: ${ctx.goal ?? "general fitness"}${stravaSection}`,
        maxTokens: 1400,
      });
      const { _model: _, ...planData } = result;
      return NextResponse.json(planData as RegimenPlanResult);
    }

    // ── notes-summarize ────────────────────────────────────────────────────────
    if (mode === "notes-summarize") {
      const noteCtx = title ? `Note: "${title}"\n\n` : "";
      const { text: summary } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: "You are an expert note summarizer. Given note content, produce a concise summary as 3-5 Markdown bullet points. Return only the bullets, no preamble.",
        userMessage: `${noteCtx}${stripHtml(text).slice(0, 6000)}`,
        maxTokens: 500,
      });
      return NextResponse.json({ summary });
    }

    // ── notes-rewrite ──────────────────────────────────────────────────────────
    if (mode === "notes-rewrite") {
      const { text: rewritten } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: "You are an expert editor. Rewrite the given text to be clearer, more concise, and better structured while preserving all key information and the author's voice. Return only the rewritten prose, no preamble.",
        userMessage: stripHtml(text).slice(0, 6000),
        maxTokens: 1200,
      });
      return NextResponse.json({ rewritten });
    }

    // ── notes-title ────────────────────────────────────────────────────────────
    // Gemini eligible — tiny output, simple generation
    if (mode === "notes-title") {
      const { text: generated } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: "Generate a precise, descriptive title for this note (5-10 words). Return only the title, nothing else.",
        userMessage: stripHtml(text).slice(0, 3000),
        maxTokens: 60,
      });
      return NextResponse.json({ title: generated });
    }

    // ── meeting-summary ────────────────────────────────────────────────────────
    if (mode === "meeting-summary") {
      const noteCtx = title ? `Note title: ${title}\n\n` : "";
      const { text: summary } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: "You are an expert meeting note-taker. Given a transcript (possibly rough speech-to-text), produce a clean structured summary in Markdown. Format exactly as:\n\n## Meeting Summary\n\n**Key Points:**\n- ...\n\n**Action Items:**\n- ...\n\n**Decisions Made:**\n- ...\n\nKeep each bullet concise (one line). If a section has nothing, write '- None identified'. Return only the Markdown, no preamble.",
        userMessage: `${noteCtx}Transcript:\n${text.slice(0, 6000)}`,
        maxTokens: 700,
      });
      return NextResponse.json({ summary });
    }

    // ── route ──────────────────────────────────────────────────────────────────
    // Gemini eligible — pure JSON routing
    if (mode === "route") {
      const result = await aiJSON<RouteResult>({
        mode,
        anthropic,
        providerPref,
        system: 'You route a research note to the right destination in a personal knowledge OS. Given a note title and body, return ONLY a JSON object with keys: destination ("research" = working research notes, "literature" = a referenced paper/citation to file in the literature library, "task" = an actionable to-do), label (short human destination name, e.g. "New task" or "Literature library"), reason (one sentence, max 22 words, explaining the choice), tags (array of 1-4 short lowercase keywords). No markdown, no explanation.',
        userMessage: `title: ${text}\nbody: ${stripHtml(body ?? "").slice(0, 4000)}`,
        maxTokens: 250,
      });
      const { _model: _, ...routeData } = result;
      return NextResponse.json(routeData as RouteResult);
    }

    // ── triage ─────────────────────────────────────────────────────────────────
    // Gemini eligible — pure JSON classification
    if (mode === "triage") {
      const result = await aiJSON<TriageResult>({
        mode,
        anthropic,
        providerPref,
        system: 'You are a task router for a personal OS. Given a signal title and optional body, return ONLY a JSON object with keys: title (string, cleaned up), priority ("hi"|"med"|"lo"), category ("clinical"|"research"|"life"|"personal"|"admin"), effort ("~15m"|"~1h"|"~2h"|"~3h+"). No markdown, no explanation.',
        userMessage: `title: ${text}\nbody: ${body ?? ""}`,
        maxTokens: 200,
      });
      const { _model: _, ...triageData } = result;
      return NextResponse.json(triageData as TriageResult);
    }

    // ── debrief_summary ────────────────────────────────────────────────────────
    if (mode === "debrief_summary") {
      const { text: summary } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: `You are a reflective intelligence layer. Given a series of weekly reflection notes, synthesize the key patterns, recurring themes, wins, and friction points into a concise weekly summary. Write in second person ("You've been..."). Keep it under 200 words. No markdown headers. Focus on insight, not repetition.`,
        userMessage: text,
        maxTokens: 350,
      });
      return NextResponse.json({ summary });
    }

    // ── capture (default) ──────────────────────────────────────────────────────
    // Gemini eligible — tiny classification
    const result = await aiJSON<CaptureResult>({
      mode: "capture",
      anthropic,
      system: 'You are an intelligent personal assistant. Classify this captured thought. Return ONLY a JSON object with keys: label (1-3 words), action (imperative phrase, max 8 words), priority ("hi"|"med"|"lo"). No markdown, no explanation.',
      userMessage: text,
      maxTokens: 150,
    });
    const { _model: _, ...captureData } = result;
    return NextResponse.json(captureData as CaptureResult);

  } catch {
    // ── Error fallbacks ────────────────────────────────────────────────────────
    if (mode === "companion") return NextResponse.json({ response: "Something went wrong. Try again." });
    if (mode === "deck-insights") return NextResponse.json({ cards: fallbackDeckCards(text) });
    if (mode === "notes-summarize") return NextResponse.json(heuristicNoteSummarize(text, title));
    if (mode === "notes-rewrite") return NextResponse.json(heuristicNoteRewrite(text));
    if (mode === "notes-title") return NextResponse.json(heuristicNoteTitle(text));
    if (mode === "meeting-summary") return NextResponse.json(heuristicMeetingSummary(text));
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
