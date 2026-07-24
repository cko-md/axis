import { minorUnitsFor, toMajorUnitsIn } from "./currency";

/** The only availability states a financial computation may expose. */
export type FinancialInputStatus = "fresh" | "stale" | "missing" | "error";

/** Authority is explicit: values from different classes must never be blended silently. */
export type FinancialAuthority = "provider" | "manual" | "estimated" | "stale";

export type FinancialInput = {
  status: FinancialInputStatus;
  authority: FinancialAuthority;
  currency: string;
  amountMinor: number | null;
  reason?: string;
};

export type FinancialSnapshotOutcome =
  | {
      status: "fresh";
      authority: "provider";
      currency: string;
      cashMinor: number;
      investedMinor: number;
      liabilitiesMinor: number;
      netWorthMinor: number;
    }
  | {
      status: Exclude<FinancialInputStatus, "fresh">;
      authority: FinancialAuthority;
      currency: string;
      reason: string;
    };

const CURRENCY = /^[A-Z]{3}$/;
const MAX_DECIMAL_INPUT_LENGTH = 128;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

// ISO-4217 codes accepted at financially authoritative boundaries. Keeping the
// allow-list here prevents a syntactically valid typo (for example "USX") from
// silently inheriting the two-decimal fallback in currency.ts.
const SUPPORTED_CURRENCIES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS",
  "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
  "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF",
  "YER", "ZAR", "ZMW", "ZWL",
]);

export function normalizeFinancialCurrency(value: unknown, fallback = ""): string | null {
  const currency = typeof value === "string" && value.trim()
    ? value.trim().toUpperCase()
    : fallback;
  return CURRENCY.test(currency) && SUPPORTED_CURRENCIES.has(currency) ? currency : null;
}

/**
 * Expand a finite JS number's decimal spelling without performing arithmetic.
 * Provider/database adapters commonly yield numbers; this preserves the value
 * represented by their decimal string before we convert it with BigInt.
 */
function decimalText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value);
  if (!/[eE]/.test(text)) return text;

  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return null;
  const [, sign, whole, fraction = "", exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return null;
  const digits = `${whole}${fraction}`;
  const decimalAt = whole.length + exponent;
  if (decimalAt <= 0) return `${sign}0.${"0".repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${sign}${digits}${"0".repeat(decimalAt - digits.length)}`;
  return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

/**
 * Parse a decimal into an exact scaled integer and round half away from zero
 * based on the next decimal digit. This never uses `Number() * factor`, which
 * can round a valid cent before the financial rounding rule runs.
 */
export function strictScaledUnits(value: unknown, scale: number): number | null {
  if (!Number.isSafeInteger(scale) || scale <= 0) return null;
  const text = decimalText(value);
  if (text && text.length > MAX_DECIMAL_INPUT_LENGTH) return null;
  const match = text?.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const decimals = String(scale).length - 1;
  if (10 ** decimals !== scale) return null;
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const discarded = fraction[decimals];
  let units = BigInt(whole) * BigInt(scale) + BigInt(kept || "0");
  if (discarded && discarded >= "5") units += BigInt(1);
  if (sign === "-") units = -units;
  const numeric = Number(units);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function safeNumber(value: bigint): number | null {
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) return null;
  return Number(value);
}

function exactDecimalRatio(value: unknown): { numerator: bigint; denominator: bigint } | null {
  const text = decimalText(value);
  if (!text || text.length > MAX_DECIMAL_INPUT_LENGTH) return null;
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const digits = `${whole}${fraction}`;
  const numerator = BigInt(digits) * (sign === "-" ? BigInt(-1) : BigInt(1));
  return {
    numerator,
    denominator: BigInt(10) ** BigInt(fraction.length),
  };
}

function divideRoundedHalfAwayFromZero(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= BigInt(0)) return null;
  const negative = numerator < BigInt(0);
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  if (remainder * BigInt(2) >= denominator) quotient += BigInt(1);
  return safeNumber(negative ? -quotient : quotient);
}

/** Construct a fresh input from already-normalized minor units without a major-unit round trip. */
export function financialInputMinor(
  amountMinor: number,
  input: Omit<FinancialInput, "amountMinor" | "status">,
): FinancialInput {
  const currency = normalizeFinancialCurrency(input.currency);
  if (!currency) {
    return { status: "error", authority: input.authority, currency: "", amountMinor: null, reason: "invalid_currency" };
  }
  if (!Number.isSafeInteger(amountMinor)) {
    return { status: "error", authority: input.authority, currency, amountMinor: null, reason: "invalid_amount" };
  }
  return { status: "fresh", authority: input.authority, currency, amountMinor };
}

/** Checked minor-unit addition. The result is null only when the final integer is unsafe. */
export function addMinorUnits(...values: readonly number[]): number | null {
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  return safeNumber(values.reduce((total, value) => total + BigInt(value), BigInt(0)));
}

/** Exact `(quantity * price) / scale`, rounded half away from zero. */
export function multiplyScaledMinorUnits(
  quantity: number,
  priceMinor: number,
  scale: number,
): number | null {
  if (![quantity, priceMinor, scale].every(Number.isSafeInteger) || scale <= 0) return null;
  const numerator = BigInt(quantity) * BigInt(priceMinor);
  const denominator = BigInt(scale);
  return divideRoundedHalfAwayFromZero(numerator, denominator);
}

/**
 * Multiply a scaled quantity by a decimal major-unit price and round exactly
 * once at the final currency boundary. A quote may legitimately carry more
 * precision than the settlement currency, so converting it to cents before
 * multiplying fractional shares would lose information.
 */
export function multiplyScaledQuantityByDecimalPrice(
  quantity: number,
  priceMajor: unknown,
  quantityScale: number,
  currency: string,
): number | null {
  const normalized = normalizeFinancialCurrency(currency, "");
  const price = exactDecimalRatio(priceMajor);
  if (
    !normalized
    || !price
    || !Number.isSafeInteger(quantity)
    || !Number.isSafeInteger(quantityScale)
    || quantityScale <= 0
  ) return null;
  const numerator = BigInt(quantity) * price.numerator * BigInt(minorUnitsFor(normalized));
  const denominator = BigInt(quantityScale) * price.denominator;
  return divideRoundedHalfAwayFromZero(numerator, denominator);
}

/** Exact numeric text for persistence in a Postgres numeric column. */
export function minorUnitsToDecimalString(amountMinor: number, currency: string): string | null {
  const normalized = normalizeFinancialCurrency(currency);
  if (!normalized || !Number.isSafeInteger(amountMinor)) return null;
  return scaledUnitsToDecimalString(amountMinor, minorUnitsFor(normalized));
}

/** Exact decimal text for any power-of-ten scaled safe integer. */
export function scaledUnitsToDecimalString(amount: number, scale: number): string | null {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(scale) || scale <= 0) return null;
  const decimals = String(scale).length - 1;
  if (10 ** decimals !== scale) return null;
  const value = BigInt(amount);
  const sign = value < BigInt(0) ? "-" : "";
  const magnitude = value < BigInt(0) ? -value : value;
  if (decimals === 0) return `${sign}${magnitude}`;
  const digits = magnitude.toString().padStart(decimals + 1, "0");
  return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * Strict parser for authoritative inputs. Unlike legacy display helpers, an
 * invalid provider/manual amount is absence/error, never a fabricated zero.
 */
export function strictMinorUnits(value: unknown, currency: string): number | null {
  const normalized = normalizeFinancialCurrency(currency, "");
  return normalized ? strictScaledUnits(value, minorUnitsFor(normalized)) : null;
}

/**
 * Parse a provider amount only when it is already exact at the currency's
 * ISO-4217 minor-unit exponent. Unlike `strictMinorUnits`, this boundary never
 * rounds excess provider precision: authoritative persistence must reject an
 * amount it cannot represent exactly.
 */
export function strictExactMinorUnits(value: unknown, currency: string): number | null {
  const normalized = normalizeFinancialCurrency(currency, "");
  if (!normalized) return null;
  const text = decimalText(value);
  if (!text || text.length > MAX_DECIMAL_INPUT_LENGTH) return null;
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const scale = minorUnitsFor(normalized);
  const decimals = String(scale).length - 1;
  const significantExcess = fraction.slice(decimals).replace(/0+$/, "");
  if (significantExcess) return null;
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const units = (BigInt(whole) * BigInt(scale) + BigInt(kept || "0"))
    * (sign === "-" ? BigInt(-1) : BigInt(1));
  return safeNumber(units);
}

export function financialInput(
  value: unknown,
  input: Omit<FinancialInput, "amountMinor" | "status"> & { status?: FinancialInputStatus },
): FinancialInput {
  const currency = normalizeFinancialCurrency(input.currency);
  if (!currency) {
    return { status: "error", authority: input.authority, currency: "", amountMinor: null, reason: "invalid_currency" };
  }
  const requestedStatus = input.status ?? "fresh";
  if (requestedStatus !== "fresh") {
    return { status: requestedStatus, authority: input.authority, currency, amountMinor: null, ...(input.reason ? { reason: input.reason } : {}) };
  }
  const amountMinor = input.authority === "provider"
    ? strictExactMinorUnits(value, currency)
    : strictMinorUnits(value, currency);
  if (amountMinor === null) {
    return { status: "error", authority: input.authority, currency, amountMinor: null, reason: "invalid_amount" };
  }
  return { status: "fresh", authority: input.authority, currency, amountMinor };
}

/** Convert a typed minor-unit input at the display boundary only. */
export function financialMajor(input: FinancialInput): number | null {
  return input.amountMinor === null ? null : toMajorUnitsIn(input.amountMinor, input.currency);
}

/**
 * Build a net-worth outcome only from complete, fresh provider inputs in one
 * currency. Any unavailable component stays unavailable—it is never zeroed.
 */
export function completeProviderSnapshot(input: {
  cash: FinancialInput;
  invested: FinancialInput;
  liabilities: FinancialInput;
}): FinancialSnapshotOutcome {
  const values = [input.cash, input.invested, input.liabilities];
  const firstUnavailable = values.find((value) => value.status !== "fresh" || value.amountMinor === null);
  if (firstUnavailable) {
    return {
      status: firstUnavailable.status === "fresh" ? "error" : firstUnavailable.status,
      authority: firstUnavailable.authority,
      currency: firstUnavailable.currency,
      reason: firstUnavailable.reason ?? "incomplete_financial_input",
    };
  }
  const currencies = new Set(values.map((value) => value.currency));
  if (currencies.size !== 1) {
    return { status: "error", authority: "estimated", currency: input.cash.currency, reason: "mixed_currency_without_fx" };
  }
  const nonProvider = values.find((value) => value.authority !== "provider");
  if (nonProvider) {
    return {
      status: "error",
      authority: nonProvider.authority,
      currency: nonProvider.currency,
      reason: "non_provider_authority_cannot_form_provider_snapshot",
    };
  }
  const cashMinor = input.cash.amountMinor as number;
  const investedMinor = input.invested.amountMinor as number;
  const liabilitiesMinor = input.liabilities.amountMinor as number;
  if (investedMinor < 0 || liabilitiesMinor < 0) {
    return {
      status: "error",
      authority: "provider",
      currency: input.cash.currency,
      reason: investedMinor < 0 ? "negative_invested_balance" : "negative_liability_balance",
    };
  }
  // Do the whole equation in BigInt. Checking only the final Number is not
  // enough: MAX_SAFE + 2 - 2 has an unsafe intermediate and loses one cent in
  // IEEE-754 even though the mathematically final value is safe.
  const netWorthMinor = safeNumber(
    BigInt(cashMinor) + BigInt(investedMinor) - BigInt(liabilitiesMinor),
  );
  if (netWorthMinor === null) {
    return { status: "error", authority: "provider", currency: input.cash.currency, reason: "net_worth_out_of_range" };
  }
  return {
    status: "fresh",
    authority: "provider",
    currency: input.cash.currency,
    cashMinor,
    investedMinor,
    liabilitiesMinor,
    netWorthMinor,
  };
}
