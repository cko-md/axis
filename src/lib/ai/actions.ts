import { z } from "zod";
import { aiDeckCardSchema } from "@/lib/ai/navigation";
import { aiResponseMetadataSchema } from "@/lib/ai/response";

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
const withResponseMetadata = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, meta: aiResponseMetadataSchema }).strict();

const flashcard = z.object({
  front: z.string().min(1).max(120),
  back: z.string().min(1).max(300),
}).strict();

const quizItem = z.object({
  question: z.string().min(1).max(160),
  answer: z.string().min(1).max(400),
}).strict();

export const AI_ACTION_DEFS = {
  triage: {
    mode: "triage",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: withResponseMetadata({
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
    output: withResponseMetadata({
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
    output: withResponseMetadata({ summary: z.string() }),
  },
  noteRewrite: {
    mode: "notes-rewrite",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: withResponseMetadata({ rewritten: z.string() }),
  },
  noteTitle: {
    mode: "notes-title",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: withResponseMetadata({ title: z.string() }),
  },
  flashcards: {
    mode: "flashcards",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: withResponseMetadata({ cards: z.array(flashcard).max(12) }),
  },
  quiz: {
    mode: "quiz",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: withResponseMetadata({ items: z.array(quizItem).max(8) }),
  },
  mindmap: {
    mode: "mindmap",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: withResponseMetadata({ root: z.object({ label: z.string(), children: z.array(z.unknown()).optional() }).strict() }),
  },
  studySummary: {
    mode: "summary",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: withResponseMetadata({ summary: z.string() }),
  },
  debriefSummary: {
    mode: "debrief_summary",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: withResponseMetadata({ summary: z.string() }),
  },
  capture: {
    mode: "capture",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: withResponseMetadata({ label: z.string(), action: z.string(), priority }),
  },
  meetingSummary: {
    mode: "meeting-summary",
    sensitive: true,
    input: z.object({ text: z.string().min(1), title: z.string().optional() }),
    output: withResponseMetadata({ summary: z.string() }),
  },
  // Companion and deck-insights are consumed through callAiAction and therefore
  // use strict response schemas. Regimen outputs remain loose until their
  // existing call sites migrate to the typed client.
  companion: {
    mode: "companion",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: withResponseMetadata({ response: z.string() }),
  },
  deckInsights: {
    mode: "deck-insights",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: withResponseMetadata({ cards: z.array(aiDeckCardSchema).max(5) }),
  },
  regimen: {
    mode: "regimen",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({ meta: aiResponseMetadataSchema }).passthrough(),
  },
  regimenPlan: {
    mode: "regimenPlan",
    sensitive: true,
    input: z.object({ text: z.string().min(1), body: z.string().optional() }),
    output: z.object({ meta: aiResponseMetadataSchema }).passthrough(),
  },
  musicRecs: {
    mode: "music-recs",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: withResponseMetadata({
      recs: z.array(z.object({
        artist: z.string(),
        track: z.string(),
        reason: z.string(),
        genre: z.string(),
      }).strict()).max(6),
    }),
  },
  mealParse: {
    mode: "meal-parse",
    sensitive: true,
    input: z.object({ text: z.string().min(1) }),
    output: withResponseMetadata({
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
