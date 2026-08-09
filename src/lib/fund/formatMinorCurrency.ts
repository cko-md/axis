import { minorUnitsToDecimalString, normalizeFinancialCurrency } from "./financialTruth";

/** Display-only formatting from an already-authoritative minor-unit integer. */
export function formatSignedMinorCurrency(
  amountMinor: number,
  currency: string,
  locale = "en-US",
): string | null {
  const normalized = normalizeFinancialCurrency(currency, "");
  if (!normalized || !Number.isSafeInteger(amountMinor)) return null;
  const exact = minorUnitsToDecimalString(Math.abs(amountMinor), normalized);
  if (!exact) return null;
  const [, fraction] = exact.split(".");
  const whole = BigInt(exact.split(".")[0]);
  const rendered = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: normalized,
  }).formatToParts(whole).map((part) => {
    if (part.type === "fraction") return fraction ?? part.value;
    return part.value;
  }).join("");
  return amountMinor >= 0 ? `+${rendered}` : `−${rendered}`;
}
