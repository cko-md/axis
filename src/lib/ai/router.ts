/**
 * AI Model Router
 *
 * Default ("auto") picks the cheapest capable model for each task:
 *   1. Gemini Flash (free tier) — simple JSON classification & short text
 *   2. Claude Haiku             — writing quality, personality, complex JSON
 *
 * Modes routed to Gemini first under "auto" (falls back to Haiku on error / missing key):
 *   capture | triage | triage-person | route | notes-title | platform-scan | feed-discovery |
 *   objectives-scan | literature-relevance
 *
 * Modes always on Haiku under "auto" (quality / conversation / long output):
 *   companion | notes-summarize | notes-rewrite | meeting-summary |
 *   deck-insights | regimen | regimenPlan | agenda-rebuild | pipeline-draft
 *
 * A user can override this via profiles.ai_provider ("gemini" | "anthropic"),
 * forcing every mode onto that provider (falling back to the other only if
 * the forced one is unavailable/fails). This NEVER affects embedText()
 * (src/lib/ai/embed.ts) — semantic search stays Gemini-only regardless,
 * since switching embedding providers would silently break vector search.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { getGeminiApiKey } from "@/lib/env";

// ── Gemini config ──────────────────────────────────────────────────────────────

// gemini-1.5-flash was retired by Google and 404s — gemini-2.5-flash is the
// current stable equivalent for cheap classification/short-text generation.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Tasks suitable for Gemini: small outputs, JSON classification, no personality required
export const GEMINI_ELIGIBLE = new Set([
  "capture",
  "triage",
  "triage-person",
  "route",
  "notes-title",
  "platform-scan",
  "feed-discovery",
  // Same shape as platform-scan (JSON array of {target/title, module/source,
  // confidence}) — was previously Haiku-only, which meant the Objectives
  // "Scan platform for targets" feature silently returned [] in any
  // environment with only GEMINI_API_KEY set (no ANTHROPIC_API_KEY).
  "objectives-scan",
  // Small JSON extraction task (one relevance sentence keyed to the user's
  // saved topics) — no personality/voice required, fits Gemini Flash.
  "literature-relevance",
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
  const key = getGeminiApiKey();
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
        // These modes are short deterministic classification/generation —
        // 2.5 Flash's "thinking" tokens count against maxOutputTokens and can
        // starve the actual answer on tight budgets (e.g. notes-title at 60).
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}`);
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

export type AIProviderPref = "auto" | "gemini" | "anthropic";

export interface AIGenerateParams {
  mode: string;
  system: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  anthropic: Anthropic | null;
  // For multi-turn modes (companion, etc.)
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  // User's profiles.ai_provider preference. Defaults to "auto" (cost-routed).
  providerPref?: AIProviderPref;
}

export interface AIGenerateResult {
  text: string;
  model: string;
}

/**
 * Smart AI call: Gemini Flash → Claude Haiku, in order of cost (under "auto"),
 * or a forced provider per providerPref. Always returns { text, model } —
 * caller decides how to parse.
 */
export async function aiGenerate(params: AIGenerateParams): Promise<AIGenerateResult> {
  const { mode, system, userMessage, maxTokens, temperature, anthropic, conversationHistory, providerPref = "auto" } = params;

  const tryGemini = providerPref === "gemini" || (providerPref === "auto" && GEMINI_ELIGIBLE.has(mode));

  // ── Tier 1: Gemini Flash ─────────────────────────────────────────────────────
  if (tryGemini && getGeminiApiKey()) {
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
    } catch (err) {
      // Fall through to Haiku — surface the real cause so a misconfigured/
      // failing Gemini call isn't masked by the generic "no AI client" throw.
      console.error(`[ai/router] Gemini failed (mode=${mode}):`, err instanceof Error ? err.message : "unknown");
    }
  }

  // ── Tier 2: Claude Haiku ────────────────────────────────────────────────────
  if (!anthropic) {
    // No Anthropic client (ANTHROPIC_API_KEY unset) — if we haven't already
    // tried Gemini above (i.e. this mode isn't GEMINI_ELIGIBLE and provider
    // isn't forced to gemini), fall back to it now rather than throwing.
    // Without this, any Haiku-only mode (companion, deck-insights, etc.) hard
    // fails in Gemini-only environments instead of degrading gracefully.
    if (!tryGemini && getGeminiApiKey()) {
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
    }
    throw new Error("No AI client available — set ANTHROPIC_API_KEY or GEMINI_API_KEY");
  }

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
