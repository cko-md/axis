import { minorUnitsToDecimalString, strictMinorUnits } from "./financialTruth";

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
/** Legacy display helper retained for protected callers; never use for authority. */
export function safeMoney(value: unknown): number {
  const exact = strictNarrationMoney(value);
  return exact?.amountMinor === undefined ? 0 : exact.amountMinor / 100;
}

/** Exact fail-closed contract used by all financial narration payloads. */
export function strictNarrationMoney(value: unknown): { amount: string; amountMinor: number } | null {
  const amountMinor = strictMinorUnits(value, "USD");
  const amount = amountMinor === null ? null : minorUnitsToDecimalString(amountMinor, "USD");
  return amount === null || amountMinor === null ? null : { amount, amountMinor };
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

export function shapeRecurringForFinancialNarration<T extends { merchant_name?: unknown; expected_amount?: unknown; cadence?: unknown; last_seen_date?: unknown }>(
  rows: T[] | null | undefined,
): Array<{ merchant_name: string; expected_amount: string | null; expected_amount_minor: number | null; cadence: string; last_seen_date: string | null }> {
  return (rows ?? []).slice(0, MAX_RECURRING_ITEMS).map((row) => {
    const money = strictNarrationMoney(row.expected_amount);
    return {
      merchant_name: cleanFinanceLabel(row.merchant_name, "Unknown merchant"),
      expected_amount: money?.amount ?? null,
      expected_amount_minor: money?.amountMinor ?? null,
      cadence: cleanFinanceLabel(row.cadence, "unknown"),
      last_seen_date: typeof row.last_seen_date === "string" ? row.last_seen_date.slice(0, 40) : null,
    };
  });
}
