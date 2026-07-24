import { minorUnitsToDecimalString, normalizeFinancialCurrency, strictMinorUnits } from "./financialTruth";

/** Categories Axis exposes for spending review and budget assignment. */
export const ACTIVITY_CATEGORIES = [
  "FOOD_AND_DRINK",
  "GROCERIES",
  "TRANSPORTATION",
  "MEDICAL",
  "ENTERTAINMENT",
  "SUBSCRIPTION",
  "RENT_AND_UTILITIES",
  "TRAVEL",
  "GENERAL_MERCHANDISE",
  "OTHER",
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

const CATEGORY_ALIASES: Record<string, ActivityCategory> = {
  FOOD_AND_DRINK: "FOOD_AND_DRINK",
  FOOD_AND_BEVERAGE: "FOOD_AND_DRINK",
  DINING: "FOOD_AND_DRINK",
  RESTAURANTS: "FOOD_AND_DRINK",
  GROCERIES: "GROCERIES",
  TRANSPORTATION: "TRANSPORTATION",
  TRANSPORT: "TRANSPORTATION",
  MEDICAL: "MEDICAL",
  HEALTHCARE: "MEDICAL",
  ENTERTAINMENT: "ENTERTAINMENT",
  SUBSCRIPTION: "SUBSCRIPTION",
  SUBSCRIPTIONS: "SUBSCRIPTION",
  RENT_AND_UTILITIES: "RENT_AND_UTILITIES",
  RENT: "RENT_AND_UTILITIES",
  UTILITIES: "RENT_AND_UTILITIES",
  TRAVEL: "TRAVEL",
  GENERAL_MERCHANDISE: "GENERAL_MERCHANDISE",
  GENERAL_SERVICES: "GENERAL_MERCHANDISE",
  HOME_IMPROVEMENT: "GENERAL_MERCHANDISE",
  PERSONAL_CARE: "GENERAL_MERCHANDISE",
};

/**
 * Converts a provider category into Axis's stable spending taxonomy. Unknown
 * labels become OTHER instead of being guessed from a merchant name.
 */
export function categorizeProviderActivity(providerCategory: unknown): ActivityCategory {
  if (typeof providerCategory !== "string") return "OTHER";
  const key = normalizeActivityCategoryLabel(providerCategory);
  return CATEGORY_ALIASES[key] ?? "OTHER";
}

/** A user-set category always takes priority over provider classification. */
export function resolveActivityCategory(input: {
  customCategory?: string | null;
  providerCategory?: string | null;
}): { category: string; source: "manual" | "provider" } {
  if (input.customCategory && input.customCategory.trim()) {
    return { category: normalizeActivityCategoryLabel(input.customCategory), source: "manual" };
  }
  return { category: categorizeProviderActivity(input.providerCategory), source: "provider" };
}

function normalizeActivityCategoryLabel(value: string): string {
  return value.trim().toUpperCase().replace(/[\s/-]+/g, "_");
}

export type ActivityAnomalyInput = {
  id: string;
  merchantName?: string | null;
  amount: unknown;
  currency?: string | null;
  isTransfer?: boolean;
  pending?: boolean;
};

export type ActivityAnomalyReason = "new_merchant_high_amount" | "merchant_amount_outlier";

export type ActivityAnomalyAssessment = {
  available: boolean;
  flagged: boolean;
  reason: ActivityAnomalyReason | null;
  amountMinor: number | null;
  currency: string;
  merchantKey: string | null;
  sampleCount: number;
  baselineAverageMinor: number | null;
};

export type ActivityAnomalyRules = {
  /** Currency in which the unfamiliar-merchant threshold is defined. */
  newMerchantThresholdCurrency: string;
  /** Minor-unit threshold for an unfamiliar merchant in that currency only. */
  newMerchantThresholdMinor: number;
  /** Require this many prior same-merchant entries before an outlier check. */
  minimumMerchantSamples: number;
  /** Numerator for the strict outlier multiplier, e.g. 2 / 1 means >2x. */
  outlierMultiplierNumerator: number;
  outlierMultiplierDenominator: number;
};

export const DEFAULT_USD_ACTIVITY_ANOMALY_RULES: ActivityAnomalyRules = {
  newMerchantThresholdCurrency: "USD",
  newMerchantThresholdMinor: 20_000,
  minimumMerchantSamples: 1,
  outlierMultiplierNumerator: 2,
  outlierMultiplierDenominator: 1,
};

/** Stable comparison key; it never overwrites the provider merchant label. */
export function normalizeActivityMerchantKey(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

/**
 * Deterministically evaluates a debit against comparable prior activity.
 * Arithmetic stays in minor units; other-currency, transfer, pending, and
 * self-history entries are not comparable.
 */
export function assessActivityAnomaly(
  transaction: ActivityAnomalyInput,
  history: readonly ActivityAnomalyInput[],
  rules: ActivityAnomalyRules = DEFAULT_USD_ACTIVITY_ANOMALY_RULES,
): ActivityAnomalyAssessment {
  // Omitted currency is the legacy/manual function default. Provider-shaped
  // callers pass an explicit string or null; null/unknown remains unavailable.
  const normalizedCurrency = normalizeFinancialCurrency(
    transaction.currency,
    transaction.currency === undefined ? "USD" : "",
  );
  const currency = normalizedCurrency ?? "USD";
  const rulesValid = normalizeFinancialCurrency(rules.newMerchantThresholdCurrency, "") !== null
    && Number.isSafeInteger(rules.newMerchantThresholdMinor)
    && rules.newMerchantThresholdMinor >= 0
    && Number.isSafeInteger(rules.minimumMerchantSamples)
    && rules.minimumMerchantSamples >= 1
    && Number.isSafeInteger(rules.outlierMultiplierNumerator)
    && rules.outlierMultiplierNumerator > 0
    && Number.isSafeInteger(rules.outlierMultiplierDenominator)
    && rules.outlierMultiplierDenominator > 0;
  const rawAmountMinor = normalizedCurrency && rulesValid
    ? strictMinorUnits(transaction.amount, normalizedCurrency)
    : null;
  const amountMinor = rawAmountMinor === null ? null : Math.abs(rawAmountMinor);
  const merchantKey = normalizeActivityMerchantKey(transaction.merchantName);
  const empty: ActivityAnomalyAssessment = {
    available: rawAmountMinor !== null,
    flagged: false,
    reason: null,
    amountMinor,
    currency,
    merchantKey,
    sampleCount: 0,
    baselineAverageMinor: null,
  };

  if (
    rawAmountMinor === null ||
    amountMinor === null ||
    !merchantKey ||
    transaction.isTransfer ||
    transaction.pending ||
    rawAmountMinor >= 0
  ) return empty;

  const comparableAmounts: number[] = [];
  for (const entry of history) {
    if (entry.id === transaction.id || entry.isTransfer || entry.pending) continue;
    const entryCurrency = normalizeFinancialCurrency(
      entry.currency,
      entry.currency === undefined ? "USD" : "",
    );
    if (entryCurrency !== currency) continue;
    if (normalizeActivityMerchantKey(entry.merchantName) !== merchantKey) continue;
    const rawMinor = strictMinorUnits(entry.amount, currency);
    if (rawMinor === null) return { ...empty, available: false };
    if (rawMinor < 0) comparableAmounts.push(Math.abs(rawMinor));
  }

  if (comparableAmounts.length === 0) {
    const flagged = currency === normalizeFinancialCurrency(rules.newMerchantThresholdCurrency, "")
      && amountMinor > rules.newMerchantThresholdMinor;
    return { ...empty, flagged, reason: flagged ? "new_merchant_high_amount" : null };
  }

  const totalMinorBig = comparableAmounts.reduce((total, value) => total + BigInt(value), BigInt(0));
  if (totalMinorBig > BigInt(Number.MAX_SAFE_INTEGER)) return { ...empty, available: false };
  const countBig = BigInt(comparableAmounts.length);
  const baselineAverageBig = (totalMinorBig + countBig / BigInt(2)) / countBig;
  if (baselineAverageBig > BigInt(Number.MAX_SAFE_INTEGER)) return { ...empty, available: false };
  const baselineAverageMinor = Number(baselineAverageBig);
  const isOutlier = comparableAmounts.length >= rules.minimumMerchantSamples
    && BigInt(amountMinor) * countBig * BigInt(rules.outlierMultiplierDenominator)
      > totalMinorBig * BigInt(rules.outlierMultiplierNumerator);

  return {
    ...empty,
    flagged: isOutlier,
    reason: isOutlier ? "merchant_amount_outlier" : null,
    sampleCount: comparableAmounts.length,
    baselineAverageMinor,
  };
}

export function activityAnomalyReason(assessment: ActivityAnomalyAssessment): string | null {
  if (!assessment.available || assessment.amountMinor === null || !assessment.flagged || !assessment.reason) return null;
  const amount = `${minorUnitsToDecimalString(assessment.amountMinor, assessment.currency)} ${assessment.currency}`;
  if (assessment.reason === "new_merchant_high_amount") {
    return `first recorded transaction at this merchant, ${amount}`;
  }
  const baselineMinor = assessment.baselineAverageMinor;
  if (baselineMinor === null) return null;
  const baseline = `${minorUnitsToDecimalString(baselineMinor, assessment.currency)} ${assessment.currency}`;
  return `${amount} versus a trailing average of ${baseline} at this merchant`;
}
