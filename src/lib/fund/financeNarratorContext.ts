import { parseMoney } from "./money";

const MAX_FINANCE_LABEL_CHARS = 120;
const MAX_RECURRING_ITEMS = 10;

export function cleanFinanceLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FINANCE_LABEL_CHARS);
  return cleaned || fallback;
}

/**
 * Normalize an untrusted money value for narration/Make payloads. Delegates to
 * the deterministic {@link parseMoney} primitive so amounts are rounded to the
 * cent and non-finite input collapses to 0 (unchanged public contract).
 */
export function safeMoney(value: unknown): number {
  return parseMoney(value);
}

export function shapeRecurringForNarration<T extends { merchant_name?: unknown; expected_amount?: unknown; cadence?: unknown; last_seen_date?: unknown }>(
  rows: T[] | null | undefined,
): Array<{ merchant_name: string; expected_amount: number; cadence: string; last_seen_date: string | null }> {
  return (rows ?? []).slice(0, MAX_RECURRING_ITEMS).map((row) => ({
    merchant_name: cleanFinanceLabel(row.merchant_name, "Unknown merchant"),
    expected_amount: safeMoney(row.expected_amount),
    cadence: cleanFinanceLabel(row.cadence, "unknown"),
    last_seen_date: typeof row.last_seen_date === "string" ? row.last_seen_date.slice(0, 40) : null,
  }));
}
