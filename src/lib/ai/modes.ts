import { AI_ACTION_DEFS } from "@/lib/ai/actions";

/** Modes accepted by POST /api/ai — rejects unknown modes before LLM invocation. */
export const ALLOWED_AI_MODES = new Set<string>([
  ...Object.values(AI_ACTION_DEFS).map((def) => def.mode),
  // Route-only modes not yet in the typed action registry
  "triage-person",
  "literature-relevance",
  "pipeline-draft",
  "capture",
]);

export function isAllowedAiMode(mode: string): boolean {
  return ALLOWED_AI_MODES.has(mode);
}
