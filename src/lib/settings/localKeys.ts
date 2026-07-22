/**
 * Which localStorage keys count as "Axis-owned" for the Control Room's
 * Export / Clear local-data tools and its cached-item counter.
 *
 * The original filter was `key.startsWith("axis-")`, which silently missed:
 *  - dot-namespaced keys ("axis.literature.topics", "axis.setting.*", the
 *    per-feature "axis.<domain>.v1.<uid>" caches),
 *  - the two unprefixed keys the app actually writes ("axiom-focus" for the
 *    companion, "debrief-reminder" for the weekly reminder).
 * So "export local data" produced an incomplete backup and "clear" left those
 * behind. Centralizing the rule keeps export, clear, and the counter in sync.
 */
const UNPREFIXED_AXIS_KEYS = new Set(["axiom-focus", "debrief-reminder"]);

export function isAxisLocalKey(key: string): boolean {
  return (
    key.startsWith("axis-")
    || key.startsWith("axis.")
    || UNPREFIXED_AXIS_KEYS.has(key)
  );
}
