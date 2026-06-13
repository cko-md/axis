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

export async function POST(req: NextRequest) {
  const { mode, text, body } = (await req.json()) as { mode: string; text: string; body?: string };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (mode === "triage") return NextResponse.json(heuristicTriage(text, body));
    if (mode === "route") return NextResponse.json(heuristicRoute(text, body));
    return NextResponse.json(heuristicCapture(text));
  }

  const client = new Anthropic({ apiKey });

  try {
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
    // Anthropic error — fall back to heuristic silently
    if (mode === "triage") return NextResponse.json(heuristicTriage(text, body));
    if (mode === "route") return NextResponse.json(heuristicRoute(text, body));
    return NextResponse.json(heuristicCapture(text));
  }
}
