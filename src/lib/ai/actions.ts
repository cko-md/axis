import { z } from "zod";

// AI-2: typed AI-action registry. One declaration per client-facing AI action —
// the `/api/ai` `mode` it maps to, a zod input schema, whether it sends
// privacy-sensitive user content to the model, and the typed output shape.
//
// Why this exists: call sites previously hand-rolled `fetch("/api/ai", { body:
// JSON.stringify({ ... }) })` with ad-hoc keys, which drifted from the server
// contract (e.g. Mail sent `{ action: "triage" }` while the route reads
// `mode` + `text`, so triage silently did nothing). Routing every call through
// `callAiAction` validates the payload against this registry before it leaves
// the client, so that class of drift becomes a type error / thrown validation
// error instead of a silent no-op.
//
// `sensitive: true` marks actions that send user content (mail/note bodies,
// reflections, health, finance) to the configured LLM provider — a flag AI-4
// can assert against (never log these payloads; surface to the user).

const priority = z.enum(["hi", "med", "lo"]);

export const AI_ACTION_DEFS = {
  triage: {
    mode: "triage",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({
      title: z.string(),
      priority,
      category: z.string(),
      effort: z.string(),
    }),
  },
  route: {
    mode: "route",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({
      destination: z.enum(["research", "literature", "task"]),
      label: z.string(),
      reason: z.string(),
      tags: z.array(z.string()),
    }),
  },
  noteSummarize: {
    mode: "notes-summarize",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: z.object({ summary: z.string() }),
  },
  noteRewrite: {
    mode: "notes-rewrite",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: z.object({ rewritten: z.string() }),
  },
  noteTitle: {
    mode: "notes-title",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: z.object({ title: z.string() }),
  },
  flashcards: {
    mode: "flashcards",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: z.object({ cards: z.array(z.unknown()) }),
  },
  quiz: {
    mode: "quiz",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: z.object({ items: z.array(z.unknown()) }),
  },
  mindmap: {
    mode: "mindmap",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: z.object({ root: z.unknown() }),
  },
  studySummary: {
    mode: "summary",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: z.object({ summary: z.string() }),
  },
  debriefSummary: {
    mode: "debrief_summary",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: z.object({ summary: z.string() }),
  },
  capture: {
    mode: "capture",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: z.object({ label: z.string(), action: z.string(), priority }),
  },
  meetingSummary: {
    mode: "meeting-summary",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: z.object({ summary: z.string() }),
  },
  // The next four carry a JSON-string `body` of extra context and have
  // free-form model outputs; call sites keep their own response parsing +
  // observability and use buildAiRequestBody() for a validated request, so
  // their `output` here is intentionally loose (not consumed by callAiAction).
  companion: {
    mode: "companion",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({ response: z.string() }).passthrough(),
  },
  deckInsights: {
    mode: "deck-insights",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({ cards: z.array(z.unknown()) }).passthrough(),
  },
  regimen: {
    mode: "regimen",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({}).passthrough(),
  },
  regimenPlan: {
    mode: "regimenPlan",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({}).passthrough(),
  },
  musicRecs: {
    mode: "music-recs",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: z.object({
      recs: z.array(z.object({
        artist: z.string(),
        track: z.string(),
        reason: z.string(),
        genre: z.string(),
      })),
    }),
  },
  mealParse: {
    mode: "meal-parse",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: z.object({
      emoji: z.string(),
      title: z.string(),
      timing: z.string(),
      macros: z.string(),
    }),
  },
} as const;

export type AiActionName = keyof typeof AI_ACTION_DEFS;
export type AiActionInput<K extends AiActionName> = z.infer<(typeof AI_ACTION_DEFS)[K]["input"]>;
export type AiActionOutput<K extends AiActionName> = z.infer<(typeof AI_ACTION_DEFS)[K]["output"]>;

// Build the exact `/api/ai` request body for an action after validating the
// input against its schema. Pure + exported so the contract is unit-testable
// without a network call. Throws a descriptive error on invalid input rather
// than sending a malformed payload the server would silently ignore.
export function buildAiRequestBody<K extends AiActionName>(action: K, input: AiActionInput<K>): Record<string, unknown> {
  const def = AI_ACTION_DEFS[action];
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid input for AI action "${action}": ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  return { mode: def.mode, ...(parsed.data as Record<string, unknown>) };
}

export function isSensitiveAiAction(action: AiActionName): boolean {
  return AI_ACTION_DEFS[action].sensitive;
}
