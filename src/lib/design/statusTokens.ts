/**
 * Semantic status tokens (program §6, §12.2) — the single source of truth for
 * the small set of status colors used across the redesign surfaces (freshness
 * badges, task status chips, approval cards). Each domain keeps its own tone
 * vocabulary but resolves to one of these canonical tokens, so the palette stays
 * coherent and a color change happens in exactly one place.
 *
 * Values are CSS custom properties from the existing AXIS theme — this
 * consolidates, it does not restyle. Pure and dependency-free.
 */

export type SemanticToneKey =
  | "muted" // neutral / unknown / idle
  | "accent" // active computation / selected
  | "success" // fresh / completed / positive
  | "warning" // delayed / waiting / caution
  | "alert" // blocked
  | "danger"; // stale / failed / destructive

export const SEMANTIC_TONE_COLOR: Readonly<Record<SemanticToneKey, string>> = {
  muted: "var(--ink-faint)",
  accent: "var(--accent)",
  success: "var(--up)",
  warning: "var(--clay-2, var(--gold-deep))",
  alert: "var(--clay)",
  danger: "var(--down)",
};

export function semanticToneColor(tone: SemanticToneKey): string {
  return SEMANTIC_TONE_COLOR[tone];
}
