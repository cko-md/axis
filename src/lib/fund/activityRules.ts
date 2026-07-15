import { toMajorUnits, toMinorUnits } from "./money";

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
  flagged: boolean;
  reason: ActivityAnomalyReason | null;
  amountMinor: number;
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

function normalizeCurrency(value: string | null | undefined): string {
  const normalized = value?.trim().toUpperCase();
  return normalized || "USD";
}

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
  const rawAmountMinor = toMinorUnits(transaction.amount);
  const amountMinor = Math.abs(rawAmountMinor);
  const currency = normalizeCurrency(transaction.currency);
  const merchantKey = normalizeActivityMerchantKey(transaction.merchantName);
  const empty: ActivityAnomalyAssessment = {
    flagged: false,
    reason: null,
    amountMinor,
    currency,
    merchantKey,
    sampleCount: 0,
    baselineAverageMinor: null,
  };

  if (!merchantKey || transaction.isTransfer || transaction.pending || rawAmountMinor >= 0) return empty;

  const comparableAmounts = history.flatMap((entry) => {
    if (entry.id === transaction.id || entry.isTransfer || entry.pending) return [];
    if (normalizeCurrency(entry.currency) !== currency) return [];
    if (normalizeActivityMerchantKey(entry.merchantName) !== merchantKey) return [];
    const rawMinor = toMinorUnits(entry.amount);
    return rawMinor < 0 ? [Math.abs(rawMinor)] : [];
  });

  if (comparableAmounts.length === 0) {
    const flagged = currency === normalizeCurrency(rules.newMerchantThresholdCurrency)
      && amountMinor > rules.newMerchantThresholdMinor;
    return { ...empty, flagged, reason: flagged ? "new_merchant_high_amount" : null };
  }

  const totalMinor = comparableAmounts.reduce((total, value) => total + value, 0);
  const baselineAverageMinor = Math.round(totalMinor / comparableAmounts.length);
  const isOutlier = comparableAmounts.length >= rules.minimumMerchantSamples
    && amountMinor * comparableAmounts.length * rules.outlierMultiplierDenominator
      > totalMinor * rules.outlierMultiplierNumerator;

  return {
    ...empty,
    flagged: isOutlier,
    reason: isOutlier ? "merchant_amount_outlier" : null,
    sampleCount: comparableAmounts.length,
    baselineAverageMinor,
  };
}

export function activityAnomalyReason(assessment: ActivityAnomalyAssessment): string | null {
  if (!assessment.flagged || !assessment.reason) return null;
  const amount = `${toMajorUnits(assessment.amountMinor).toFixed(2)} ${assessment.currency}`;
  if (assessment.reason === "new_merchant_high_amount") {
    return `first recorded transaction at this merchant, ${amount}`;
  }
  const baseline = `${toMajorUnits(assessment.baselineAverageMinor ?? 0).toFixed(2)} ${assessment.currency}`;
  return `${amount} versus a trailing average of ${baseline} at this merchant`;
}
