const PERSONAL_OR_ACTIONABLE = /(?:\b(?:my|mine|me|our|we|should|could i|can i|buy|sell|trade|transfer|order|afford|allocate|rebalance)\b|[$€£¥]|\d)/i;

const CONCEPTS: ReadonlyArray<{ pattern: RegExp; answer: string }> = [
  {
    pattern: /\b(?:p\s*\/\s*e|price[- ]to[- ]earnings) ratio\b/i,
    answer: "A price-to-earnings ratio compares a company’s share price with its earnings per share. It is a valuation multiple, not a standalone measure of quality or expected return.",
  },
  {
    pattern: /\bdiversification\b/i,
    answer: "Diversification spreads exposure across assets whose risks are not perfectly correlated. It can reduce concentration risk, but it does not eliminate market-wide loss.",
  },
  {
    pattern: /\bexpense ratio\b/i,
    answer: "An expense ratio is the recurring annual fund operating cost expressed as a share of assets. It reduces investor returns and should be compared among funds with similar mandates.",
  },
  {
    pattern: /\bcompound(?:ing| interest)?\b/i,
    answer: "Compounding means returns can themselves generate later returns. Its effect depends on time, the return path, fees, taxes, and whether gains are reinvested.",
  },
];

/**
 * A deliberately narrow server-side gate for no-tool educational prose.
 * Anything personal, numeric, or actionable must use the financial evidence
 * tools and can never enter this mode.
 */
export function conceptualAdvisorAnswer(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (
    normalized.length === 0
    || normalized.length > 1_000
    || PERSONAL_OR_ACTIONABLE.test(normalized)
  ) return null;
  return CONCEPTS.find(({ pattern }) => pattern.test(normalized))?.answer ?? null;
}

export function isConceptualAdvisorQuestion(value: string): boolean {
  return conceptualAdvisorAnswer(value) !== null;
}
