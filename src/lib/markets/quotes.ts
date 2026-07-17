/**
 * Pure helpers for the batch-quotes endpoint (§11 — collapse a per-symbol N+1
 * into one request). Kept pure so symbol parsing/validation is unit-tested and
 * the route stays thin.
 */

const SYMBOL_RE = /^[A-Z0-9.:-]{1,12}$/;

/**
 * Parse a comma-separated `symbols` query into a deduped, uppercased, validated,
 * bounded list. Invalid tokens are dropped; order of first appearance is kept.
 */
export function parseSymbolList(raw: string | null | undefined, max = 25): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const sym = part.trim().toUpperCase();
    if (!SYMBOL_RE.test(sym) || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}
