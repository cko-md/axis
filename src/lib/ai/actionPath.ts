const INTERNAL_ROUTE_ROOTS = new Set([
  "agenda",
  "briefing",
  "command",
  "dispatch",
  "fund",
  "literature",
  "notes",
  "vitality",
]);

/** Keep model-authored navigation inside the AXIS application. */
export function safeActionPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  const root = path.split("/")[1] ?? "";
  return INTERNAL_ROUTE_ROOTS.has(root) ? value : undefined;
}
