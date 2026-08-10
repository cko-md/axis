const US_EQUITY_SYMBOL = /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/;

/** Canonical Public/Massive US-equity symbol grammar. */
export function normalizeUsEquitySymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return symbol.length <= 12 && US_EQUITY_SYMBOL.test(symbol) ? symbol : null;
}
