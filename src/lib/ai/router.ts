/**
 * AI Model Router
 *
 * Picks the cheapest capable model for each task:
 *   1. Gemini Flash (free tier) — simple JSON classification & short text
 *   2. Claude Haiku             — writing quality, personality, complex JSON
 *
 * Modes routed to Gemini first (falls back to Haiku on error / missing key):
 *   capture | triage | route | notes-title
 *
 * Modes always on Haiku (quality / conversation / long output):
 *   companion | notes-summarize | notes-rewrite | meeting-summary |
 *   deck-insights | regimen | regimenPlan
 */

import type Anthropic from "@anthropic-ai/sdk";

// ── Gemini config ──────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Tasks suitable for Gemini: small outputs, JSON classification, no personality required
export const GEMINI_ELIGIBLE = new Set([
  "capture",
  "triage",
  "route",
  "notes-title",
]);

type GeminiRole = "user" | "model";
interface GeminiContent {
  role: GeminiRole;
  parts: Array<{ text: string }>;
}

async function geminiGenerate(params: {
  system: string;
  messages: GeminiContent[];
  maxTokens: number;
  temperature?: number;
}): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: params.messages,
      systemInstruction: { parts: [{ text: params.system }] },
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        temperature: params.temperature ?? 0.05,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

// ── Main router ────────────────────────────────────────────────────────────────

export interface AIGenerateParams {
  mode: string;
  system: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  anthropic: Anthropic | null;
  // For multi-turn modes (companion, etc.)
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface AIGenerateResult {
  text: string;
  model: string;
}

/**
 * Smart AI call: Gemini Flash → Claude Haiku, in order of cost.
 * Always returns { text, model } — caller decides how to parse.
 */
export async function aiGenerate(params: AIGenerateParams): Promise<AIGenerateResult> {
  const { mode, system, userMessage, maxTokens, temperature, anthropic, conversationHistory } = params;

  // ── Tier 1: Gemini Flash (free) ─────────────────────────────────────────────
  if (GEMINI_ELIGIBLE.has(mode) && process.env.GEMINI_API_KEY) {
    try {
      const history: GeminiContent[] = (conversationHistory ?? []).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      const text = await geminiGenerate({
        system,
        messages: [...history, { role: "user", parts: [{ text: userMessage }] }],
        maxTokens,
        temperature,
      });
      return { text, model: `gemini/${GEMINI_MODEL}` };
    } catch {
      // Fall through to Haiku — logged server-side only
    }
  }

  // ── Tier 2: Claude Haiku ────────────────────────────────────────────────────
  if (!anthropic) throw new Error("No AI client available — set ANTHROPIC_API_KEY or GEMINI_API_KEY");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(conversationHistory ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: maxTokens,
    system,
    messages,
  });

  return {
    text: (msg.content[0] as { type: string; text: string }).text.trim(),
    model: "claude/haiku-4-5",
  };
}

/**
 * Convenience: same as aiGenerate but strips JSON fences and parses.
 * Throws if the output can't be parsed as JSON.
 */
export async function aiJSON<T>(params: AIGenerateParams): Promise<T & { _model: string }> {
  const { text, model } = await aiGenerate(params);
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = JSON.parse(cleaned) as T;
  return { ...parsed, _model: model };
}
