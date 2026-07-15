import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiGenerate, aiJSON, type AIProviderPref } from "@/lib/ai/router";
import { createClient } from "@/lib/supabase/server";
import { getGeminiApiKey, optionalEnv } from "@/lib/env";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { normalizePayload, parseJsonBody } from "@/lib/ai/request";

type CaptureResult = { label: string; action: string; priority: "hi" | "med" | "lo" };
type TriageResult = { title: string; priority: "hi" | "med" | "lo"; category: string; effort: string };
type TriagePersonResult = { name: string; role: string; note: string; tag: "mentor" | "collaborator" | "friend" };
type RouteResult = {
  destination: "research" | "literature" | "task";
  label: string;
  reason: string;
  tags: string[];
};
type LiteratureRelevanceResult = { relevance: string };

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

// Heuristic when no AI client is reachable — still topic-aware (not a static
// per-source template) so a degraded response is at least specific to the
// article, even without a model call.
function heuristicLiteratureRelevance(articleTitle: string, summary: string, topics: string[]): LiteratureRelevanceResult {
  const lower = `${articleTitle} ${summary}`.toLowerCase();
  const matched = topics.find((t) => lower.includes(t.toLowerCase().replace(/_/g, " ")));
  const relevance = matched
    ? `Touches on ${matched.replace(/_/g, " ")}, one of your saved topics — worth a skim to see how it connects to your current focus.`
    : "Couldn't generate a tailored relevance note right now — open the article to judge fit against your current focus.";
  return { relevance };
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

function heuristicTriagePerson(text: string, body?: string): TriagePersonResult {
  const lower = `${text} ${body ?? ""}`.toLowerCase();
  // Prefer a run of capitalized words (likely a proper name) over the raw text.
  const nameMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  const name = (nameMatch?.[1] ?? text).trim().slice(0, 80) || "Unknown";
  let tag: TriagePersonResult["tag"] = "collaborator";
  if (/mentor|advisor|professor|supervisor|pi\b/.test(lower)) tag = "mentor";
  if (/friend|birthday|catch up|personal/.test(lower)) tag = "friend";
  return { name, role: "", note: body ?? "", tag };
}

type PipelineDraftResult = { draft: string };

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

function heuristicDebriefSummary(text: string): { summary: string } {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const wins = lines.find((line) => /^wins?:/i.test(line) || /\*\*wins\*\*/i.test(line));
  const challenges = lines.find((line) => /^challenges?:/i.test(line) || /\*\*challenges\*\*/i.test(line));
  const focus = lines.find((line) => /^focus:/i.test(line) || /\*\*focus\*\*/i.test(line));
  const bullets = sentencesOf(text, 6).map((sentence) => `- ${sentence}`);
  const parts = [
    wins ? `**Wins:** ${wins.replace(/^\*?\*?wins\*?\*?:?\s*/i, "")}` : "",
    challenges ? `**Friction:** ${challenges.replace(/^\*?\*?challenges\*?\*?:?\s*/i, "")}` : "",
    focus ? `**Focus:** ${focus.replace(/^\*?\*?focus\*?\*?:?\s*/i, "")}` : "",
    bullets.length ? `**Patterns:**\n${bullets.join("\n")}` : "",
  ].filter(Boolean);
  return { summary: parts.join("\n\n") || "Capture wins, friction, and next focus — then summarize again." };
}

function heuristicPipelineDraft(
  text: string,
  kind: "study" | "conference" | "study-plan" = "study",
  meta?: string,
): PipelineDraftResult {
  if (kind === "study-plan") {
    const steps = [
      "Confirm study question, population, and primary endpoint.",
      "Map IRB/regulatory requirements and data-use agreements.",
      "Define analysis plan and interim milestones for this stage.",
      meta ? `Context: ${meta}` : "",
      `Next focus for “${text}”: draft one concrete deliverable due this week.`,
    ].filter(Boolean);
    return { draft: steps.map((step, index) => `${index + 1}. ${step}`).join("\n") };
  }
  const label = kind === "conference" ? "conference abstract" : "study abstract";
  return {
    draft: `Background: This ${label} addresses an important clinical question: ${text}.${meta ? ` ${meta}.` : ""}\nMethods: Retrospective/prospective design with clearly defined cohort and outcomes.\nResults: Primary findings to be populated from analysis.\nConclusion: ${text} may inform practice pending full results.`,
  };
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

// ── Study-aid types + heuristic fallbacks (no API key) ───────────────────────
type Flashcard = { front: string; back: string };
type QuizItem = { question: string; answer: string };
type MindMapNode = { label: string; children?: MindMapNode[] };

// Split prose into the most "sentence-like" chunks for heuristic generation.
function sentencesOf(text: string, limit = 12): string[] {
  return stripHtml(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)
    .slice(0, limit);
}

function heuristicFlashcards(text: string, title?: string): { cards: Flashcard[] } {
  const sentences = sentencesOf(text, 8);
  const cards: Flashcard[] = sentences.map((s) => {
    // Use the first few words as the "front" cue, the full sentence as the "back".
    const words = s.split(/\s+/);
    const front = words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
    return { front: `What about: ${front}`, back: s };
  });
  if (!cards.length) cards.push({ front: title || "This note", back: "Add more content to generate flashcards." });
  return { cards };
}

function heuristicQuiz(text: string): { items: QuizItem[] } {
  const sentences = sentencesOf(text, 6);
  const items: QuizItem[] = sentences.map((s, i) => ({
    question: `Q${i + 1}. Explain: "${s.split(/\s+/).slice(0, 8).join(" ")}…"`,
    answer: s,
  }));
  if (!items.length) items.push({ question: "Add content to generate quiz questions.", answer: "—" });
  return { items };
}

function heuristicMindMap(text: string, title?: string): { root: MindMapNode } {
  const sentences = sentencesOf(text, 6);
  return {
    root: {
      label: title || "Note",
      children: sentences.map((s) => ({ label: s.split(/\s+/).slice(0, 7).join(" ") })),
    },
  };
}

function heuristicStudySummary(text: string, title?: string): { summary: string } {
  // Same shape as notes-summarize, but framed as study notes.
  return heuristicNoteSummarize(text, title);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Rate limit: 30 requests per minute per user (Redis when available, memory fallback)
  const { success } =
    (await redisRateLimit(user.id, 30, "1 m", "axis:ai")) ??
    memoryRateLimit(`ai:${user.id}`, 30, 60_000);
  if (!success) {
    return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const normalized = normalizePayload(rawPayload);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: normalized.status });
  }
  const { mode, text, body, title } = normalized.payload;

  const { data: profile } = await supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle();
  const providerPref = (profile?.ai_provider as AIProviderPref) ?? "gemini";

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  const hasGemini = !!getGeminiApiKey();

  // No AI keys at all → heuristics only
  if (!apiKey && !hasGemini) {
    if (mode === "notes-summarize") return NextResponse.json(heuristicNoteSummarize(text, title));
    if (mode === "notes-rewrite") return NextResponse.json(heuristicNoteRewrite(text));
    if (mode === "notes-title") return NextResponse.json(heuristicNoteTitle(text));
    if (mode === "flashcards") return NextResponse.json(heuristicFlashcards(text, title));
    if (mode === "quiz") return NextResponse.json(heuristicQuiz(text));
    if (mode === "mindmap") return NextResponse.json(heuristicMindMap(text, title));
    if (mode === "summary") return NextResponse.json(heuristicStudySummary(text, title));
    if (mode === "meeting-summary") return NextResponse.json(heuristicMeetingSummary(text));
    if (mode === "triage") return NextResponse.json(heuristicTriage(text, body));
    if (mode === "triage-person") return NextResponse.json(heuristicTriagePerson(text, body));
    if (mode === "route") return NextResponse.json(heuristicRoute(text, body));
    if (mode === "literature-relevance") {
      const ctx = parseJsonBody<{ summary?: string; topics?: string[] }>(body, {});
      return NextResponse.json(heuristicLiteratureRelevance(text, ctx.summary ?? "", ctx.topics ?? []));
    }
    if (mode === "regimen") {
      const ctx = parseJsonBody<{ kind?: string; duration_min?: number; intensity?: string }>(body, {});
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
    if (mode === "debrief_summary") return NextResponse.json(heuristicDebriefSummary(text));
    if (mode === "pipeline-draft") {
      const ctx = parseJsonBody<{ kind?: "study" | "conference" | "study-plan"; role?: string; meta?: string }>(body, {});
      return NextResponse.json(heuristicPipelineDraft(text, ctx.kind ?? "study", ctx.meta));
    }
    if (mode === "music-recs") return NextResponse.json({ recs: [] });
    if (mode === "meal-parse") return NextResponse.json({ emoji: "🍽️", title: "", timing: "Logged", macros: "—" });
    return NextResponse.json(heuristicCapture(text));
  }

  // Build Anthropic client only when key is available
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  try {
    // ── companion ──────────────────────────────────────────────────────────────
    if (mode === "companion") {
      const ctx = parseJsonBody<{ context?: string; history?: Array<{ role: string; content: string }>; persona?: string }>(body, {});
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
      const ctx = parseJsonBody<{ context?: string }>(body, {});
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

    // ── music-recs ───────────────────────────────────────────────────────────
    if (mode === "music-recs") {
      const result = await aiJSON<{ recs: Array<{ artist: string; track: string; reason: string; genre: string }> }>({
        mode,
        anthropic,
        providerPref,
        system: 'You are a music recommender. Return ONLY a JSON object with key "recs": an array of exactly 3 objects, each { artist (string), track (string), reason (string, ≤140 chars — why it fits the stated taste), genre (string) }. Vary tempo and mood. No markdown, no preamble.',
        userMessage: text,
        maxTokens: 500,
      });
      return NextResponse.json({ recs: (result.recs ?? []).slice(0, 6) });
    }

    // ── meal-parse ───────────────────────────────────────────────────────────
    if (mode === "meal-parse") {
      const result = await aiJSON<{ emoji?: string; title?: string; timing?: string; macros?: string }>({
        mode,
        anthropic,
        providerPref,
        system: 'Parse a meal-log entry into structured data. Return ONLY a JSON object: { emoji (one food emoji), title (concise meal name), timing (meal type + time like "Lunch · 13:00", or "Logged" if unknown), macros (compact like "P 35 · 480 kcal", or "—" if unknown) }. No markdown, no preamble.',
        userMessage: text,
        maxTokens: 150,
      });
      return NextResponse.json({
        emoji: result.emoji || "🍽️",
        title: result.title || "",
        timing: result.timing || "Logged",
        macros: result.macros || "—",
      });
    }

    // ── regimen ────────────────────────────────────────────────────────────────
    if (mode === "regimen") {
      const ctx = parseJsonBody<{ kind?: string; duration_min?: number; intensity?: string; notes?: string }>(body, {});
      const result = await aiJSON<RegimenResult>({
        mode,
        anthropic,
        providerPref,
        system: `You are an elite personal trainer and running coach. Given a workout session spec, return ONLY a JSON object with keys: warmup (string or null), items (array of exercise objects), cooldown (string or null). Each item has: name (string), and as relevant: sets (number), reps (string like "8-12"), weight (string like "RPE 8" or "BW"), rest (string like "90s"), zone (string like "Z2" or "Z4-5"), dist (string like "6 km"), pace (string like "4:45/km"). Return no more than 8 items. No markdown.`,
        userMessage: `kind: ${ctx.kind ?? "other"}\nduration: ${ctx.duration_min ?? 45} min\nintensity: ${ctx.intensity ?? "moderate"}\ntitle: ${text}\nnotes: ${ctx.notes ?? "none"}`,
        maxTokens: 600,
      });
      return NextResponse.json({
        warmup: result.warmup,
        items: result.items,
        cooldown: result.cooldown,
      } satisfies RegimenResult);
    }

    // ── regimenPlan ────────────────────────────────────────────────────────────
    if (mode === "regimenPlan") {
      const ctx = parseJsonBody<{ discipline?: string; weeksPerPlan?: number; daysPerWeek?: number; currentLevel?: string; goal?: string; stravaContext?: string }>(body, {});
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
      return NextResponse.json({
        days: result.days,
        summary: result.summary,
      } satisfies RegimenPlanResult);
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

    // ── flashcards (study aid) ───────────────────────────────────────────────────
    if (mode === "flashcards") {
      const noteCtx = title ? `Note: "${title}"\n\n` : "";
      const result = await aiJSON<{ cards: Flashcard[] }>({
        mode,
        anthropic,
        providerPref,
        system: 'You are a study-aid generator. From the note content, produce a set of revision flashcards. Return ONLY a JSON object with key "cards": an array of 6-12 objects, each { front (a question/cue, ≤120 chars), back (the concise answer, ≤300 chars) }. Cover the most important, testable facts and concepts. No markdown, no preamble.',
        userMessage: `${noteCtx}${stripHtml(text).slice(0, 6000)}`,
        maxTokens: 1200,
      });
      const cards = Array.isArray(result.cards) ? result.cards : [];
      return NextResponse.json({ cards });
    }

    // ── quiz (study aid) ─────────────────────────────────────────────────────────
    if (mode === "quiz") {
      const noteCtx = title ? `Note: "${title}"\n\n` : "";
      const result = await aiJSON<{ items: QuizItem[] }>({
        mode,
        anthropic,
        providerPref,
        system: 'You are a study-aid generator. From the note content, write quiz questions with reveal answers. Return ONLY a JSON object with key "items": an array of 5-8 objects, each { question (a clear self-test question, ≤160 chars), answer (the model answer, ≤400 chars) }. Favor questions that test understanding, not trivia. No markdown, no preamble.',
        userMessage: `${noteCtx}${stripHtml(text).slice(0, 6000)}`,
        maxTokens: 1200,
      });
      const items = Array.isArray(result.items) ? result.items : [];
      return NextResponse.json({ items });
    }

    // ── mindmap (study aid) ──────────────────────────────────────────────────────
    if (mode === "mindmap") {
      const noteCtx = title ? `Note title: "${title}"\n\n` : "";
      const result = await aiJSON<{ root: MindMapNode }>({
        mode,
        anthropic,
        providerPref,
        system: 'You build a hierarchical mind map from note content. Return ONLY a JSON object with key "root": a node object { label (string, ≤60 chars), children (array of node objects, optional, recursive) }. The root label is the central topic. Use 3-6 top-level branches, each with 2-4 children. Keep at most 3 levels deep. No markdown, no preamble.',
        userMessage: `${noteCtx}${stripHtml(text).slice(0, 6000)}`,
        maxTokens: 1000,
      });
      const root: MindMapNode = result.root && typeof result.root === "object"
        ? result.root
        : { label: title || "Note", children: [] };
      return NextResponse.json({ root });
    }

    // ── summary (study aid) ──────────────────────────────────────────────────────
    // Study-focused summary (distinct from notes-summarize's terse bullets).
    if (mode === "summary") {
      const noteCtx = title ? `Note: "${title}"\n\n` : "";
      const { text: summary } = await aiGenerate({
        mode,
        anthropic,
        providerPref,
        system: "You are a study tutor. Given note content, produce a study summary in Markdown: a one-sentence overview, then a '**Key concepts**' section with 3-6 bullets, then a '**Remember**' section with 2-4 of the most exam-relevant takeaways. Be concise. Return only the Markdown, no preamble.",
        userMessage: `${noteCtx}${stripHtml(text).slice(0, 6000)}`,
        maxTokens: 700,
      });
      return NextResponse.json({ summary });
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
      return NextResponse.json({
        destination: result.destination,
        label: result.label,
        reason: result.reason,
        tags: result.tags,
      } satisfies RouteResult);
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
      return NextResponse.json({
        title: result.title,
        priority: result.priority,
        category: result.category,
        effort: result.effort,
      } satisfies TriageResult);
    }

    // ── triage-person ──────────────────────────────────────────────────────────
    // Gemini eligible — pure JSON extraction
    if (mode === "triage-person") {
      const result = await aiJSON<TriagePersonResult>({
        mode,
        anthropic,
        providerPref,
        system: 'You extract a person contact from a signal for a personal OS. Given a signal title and optional body, return ONLY a JSON object with keys: name (string, the person\'s name cleaned up), role (string, their role/title if mentioned, else ""), note (string, a brief context note — use the body if given, else a short summary derived from the title), tag ("mentor"|"collaborator"|"friend" — default to "collaborator" if unclear). No markdown, no explanation.',
        userMessage: `title: ${text}\nbody: ${body ?? ""}`,
        maxTokens: 200,
      });
      return NextResponse.json({
        name: result.name,
        role: result.role,
        note: result.note,
        tag: result.tag,
      } satisfies TriagePersonResult);
    }

    // ── literature-relevance ────────────────────────────────────────────────────
    // Gemini eligible — small extraction task, no personality required.
    // `text` = article title, `body` = JSON { summary, authors?, source? }.
    // Saved topics come from literature_prefs (server-side lookup, same pattern
    // as the providerPref query above) so the explanation is grounded in what
    // this specific user actually follows, not a generic persona.
    if (mode === "literature-relevance") {
      const ctx = parseJsonBody<{ summary?: string; authors?: string; source?: string; topics?: string[] }>(body, {});

      // Prefer topics passed by the client (already loaded in useLiterature's
      // state); fall back to a server-side lookup so the feature still works
      // even if the caller didn't send them. Degrades to [] (generic framing)
      // if the table doesn't exist yet — never throws.
      let topics = Array.isArray(ctx.topics) ? ctx.topics : [];
      if (!topics.length) {
        try {
          const { data: prefs } = await supabase
            .from("literature_prefs")
            .select("topics")
            .eq("user_id", user.id)
            .maybeSingle();
          topics = prefs?.topics ?? [];
        } catch {
          topics = [];
        }
      }
      const topicsLabel = topics.length
        ? topics.map((t) => t.replace(/_/g, " ")).join(", ")
        : "neuroscience research (no specific topics saved yet)";

      const result = await aiJSON<LiteratureRelevanceResult>({
        mode,
        anthropic,
        providerPref,
        system: 'You explain why a specific paper might matter to a physician-researcher, given the topics they actively follow. Return ONLY a JSON object with key "relevance": 1-2 sentences (max 50 words total), specific to this article\'s actual content — not a generic template. Reference the article\'s real subject matter and, where it genuinely connects, tie it to the reader\'s saved topics. If the connection to their topics is weak or absent, say what the article is useful for instead rather than forcing a connection. No markdown, no preamble, no restating the title verbatim.',
        userMessage: `Reader's saved topics: ${topicsLabel}\n\nArticle title: ${text}\nAuthors: ${ctx.authors ?? "unknown"}\nSource: ${ctx.source ?? "unknown"}\nSummary: ${stripHtml(ctx.summary ?? "").slice(0, 1200)}`,
        maxTokens: 150,
      });
      return NextResponse.json({
        relevance: result.relevance,
      } satisfies LiteratureRelevanceResult);
    }

    // ── pipeline-draft ─────────────────────────────────────────────────────────
    if (mode === "pipeline-draft") {
      const ctx = parseJsonBody<{ kind?: "study" | "conference" | "study-plan"; role?: string; meta?: string; next_action?: string; stage?: string }>(body, {});
      const kind = ctx.kind ?? "study";
      const metaParts = [ctx.role, ctx.meta, ctx.stage, ctx.next_action].filter(Boolean);
      const meta = metaParts.join(" · ");
      const system = kind === "study-plan"
        ? 'You are an academic project planner for a physician-researcher. Draft a concise numbered project plan (5-8 steps) for the study described. Cover regulatory/data, analysis, drafting, and the immediate next milestone. Return ONLY JSON: { "draft": "..." }. No markdown headers.'
        : 'You are an academic medical writing assistant for a physician-researcher. Draft a concise scientific abstract (Background/Methods/Results/Conclusion in plain prose, no markdown headers) for the given study or conference submission. 150-250 words. Return ONLY a JSON object with key "draft": the abstract text as a single string. No markdown, no preamble.';
      const result = await aiJSON<PipelineDraftResult>({
        mode,
        anthropic,
        providerPref,
        system,
        userMessage: `kind: ${kind}\ntitle: ${text}\ncontext: ${meta || "none"}`,
        maxTokens: kind === "study-plan" ? 400 : 500,
      });
      return NextResponse.json({
        draft: typeof result.draft === "string" ? result.draft : "",
      } satisfies PipelineDraftResult);
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
    return NextResponse.json({
      label: result.label,
      action: result.action,
      priority: result.priority,
    } satisfies CaptureResult);

  } catch (err) {
    // Logged server-side only — the client always gets a graceful fallback below,
    // never a raw 500. Without this, failures (missing/wrong API key, malformed
    // model output, upstream errors) are invisible and surface only as the
    // generic fallback strings, making them near-impossible to diagnose.
    console.error(`[ai/route] mode=${mode} failed:`, err instanceof Error ? err.message : "unknown");
    // A 429 from the model provider means the API key is valid but out of
    // quota — tell the user that specifically so they fix billing rather than
    // retrying into the same wall.
    const rateLimited = err instanceof Error && /\b429\b|quota|rate.?limit/i.test(err.message);
    // ── Error fallbacks ────────────────────────────────────────────────────────
    if (mode === "companion") {
      return NextResponse.json({
        response: rateLimited
          ? "AI quota reached — the model provider is rate-limiting requests. Check the API key's billing/quota and try again later."
          : "AI is unavailable right now. Check the model API key in Control Room.",
      });
    }
    if (mode === "deck-insights") return NextResponse.json({ cards: fallbackDeckCards(text) });
    if (mode === "music-recs") return NextResponse.json({ recs: [] });
    if (mode === "meal-parse") return NextResponse.json({ emoji: "🍽️", title: "", timing: "Logged", macros: "—" });
    if (mode === "notes-summarize") return NextResponse.json(heuristicNoteSummarize(text, title));
    if (mode === "notes-rewrite") return NextResponse.json(heuristicNoteRewrite(text));
    if (mode === "notes-title") return NextResponse.json(heuristicNoteTitle(text));
    if (mode === "flashcards") return NextResponse.json(heuristicFlashcards(text, title));
    if (mode === "quiz") return NextResponse.json(heuristicQuiz(text));
    if (mode === "mindmap") return NextResponse.json(heuristicMindMap(text, title));
    if (mode === "summary") return NextResponse.json(heuristicStudySummary(text, title));
    if (mode === "meeting-summary") return NextResponse.json(heuristicMeetingSummary(text));
    if (mode === "triage") return NextResponse.json(heuristicTriage(text, body));
    if (mode === "triage-person") return NextResponse.json(heuristicTriagePerson(text, body));
    if (mode === "route") return NextResponse.json(heuristicRoute(text, body));
    if (mode === "literature-relevance") {
      const ctx = parseJsonBody<{ summary?: string; topics?: string[] }>(body, {});
      return NextResponse.json(heuristicLiteratureRelevance(text, ctx.summary ?? "", ctx.topics ?? []));
    }
    if (mode === "regimen") {
      const ctx = parseJsonBody<{ kind?: string; duration_min?: number; intensity?: string }>(body, {});
      return NextResponse.json(fallbackRegimen(ctx.kind ?? "other", ctx.duration_min ?? 45, ctx.intensity ?? "moderate"));
    }
    if (mode === "regimenPlan") {
      return NextResponse.json({ days: [], summary: "Could not generate plan — check your API key and try again." } as RegimenPlanResult);
    }
    if (mode === "debrief_summary") return NextResponse.json(heuristicDebriefSummary(text));
    if (mode === "pipeline-draft") {
      const ctx = parseJsonBody<{ kind?: "study" | "conference" | "study-plan"; role?: string; meta?: string; next_action?: string; stage?: string }>(body, {});
      const metaParts = [ctx.role, ctx.meta, ctx.stage, ctx.next_action].filter(Boolean);
      return NextResponse.json(heuristicPipelineDraft(text, ctx.kind ?? "study", metaParts.join(" · ")));
    }
    return NextResponse.json(heuristicCapture(text));
  }
}
