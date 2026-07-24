import {
  addMinorUnits,
  multiplyScaledQuantityByDecimalPrice,
  normalizeFinancialCurrency,
  strictMinorUnits,
  strictScaledUnits,
} from "./financialTruth";
import { classifyFreshness, FRESHNESS_SLAS } from "./provenance";
import { MICRO_SHARES_PER_SHARE } from "./taxLots";

export type LivePositionReason =
  | "POSITION_NOT_FOUND"
  | "QUOTE_NOT_CONFIGURED"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_INVALID"
  | "PORTFOLIO_QUOTES_INCOMPLETE"
  | "PORTFOLIO_QUOTE_LIMIT_EXCEEDED"
  | "QUOTE_DEADLINE_EXCEEDED"
  | "QUOTE_PROVENANCE_INVALID"
  | "HOLDING_PROVENANCE_UNAVAILABLE"
  | "HOLDING_COVERAGE_UNAVAILABLE"
  | "INVALID_SYMBOL"
  | "DATA_UNAVAILABLE"
  | "MIXED_CURRENCY_REQUIRES_FX";

export type PositionHoldingInput = {
  symbol: string;
  shares: unknown;
  cost_basis?: unknown;
  currency?: unknown;
  authority?: unknown;
  source?: unknown;
  provider?: unknown;
  provider_record_id?: unknown;
  connection_id?: unknown;
  retrieved_at?: unknown;
  reconciliation_state?: unknown;
  generation_id?: unknown;
};
export type PositionQuoteInput = {
  price: unknown;
  chg: unknown;
  source?: unknown;
  asOf?: unknown;
} | null;
export type PositionConnectionInput = {
  id: unknown;
  provider: unknown;
  status: unknown;
  authority: unknown;
  verified_at: unknown;
};
export type PositionCoverageInput = {
  connection_id: unknown;
  provider: unknown;
  component: unknown;
  complete: unknown;
  record_count: unknown;
  retrieved_at: unknown;
  last_attempt_at?: unknown;
  availability_status?: unknown;
  availability_reason?: unknown;
  generation_id: unknown;
  generation_hash: unknown;
};
export const MAX_PORTFOLIO_QUOTE_SYMBOLS = 25;
const QUOTE_CONCURRENCY = 4;
const QUOTE_DEADLINE_MS = 8_000;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;

export function normalizePositionSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return SYMBOL.test(symbol) ? symbol : null;
}

/** Provider calls are allowed only for rows whose DB-enforced authority is complete. */
export function validateAuthoritativeHoldings(
  holdings: readonly PositionHoldingInput[],
  now = Date.now(),
): LivePositionReason | null {
  for (const holding of holdings) {
    if (!normalizePositionSymbol(holding.symbol)) return "INVALID_SYMBOL";
    if (
      holding.authority !== "provider" ||
      (holding.source !== "plaid" && holding.source !== "public") ||
      typeof holding.provider !== "string" ||
      !holding.provider.trim() ||
      typeof holding.provider_record_id !== "string" ||
      !holding.provider_record_id.trim() ||
      typeof holding.connection_id !== "string" ||
      !holding.connection_id ||
      typeof holding.generation_id !== "string" ||
      !holding.generation_id ||
      holding.reconciliation_state !== "matched" ||
      typeof holding.retrieved_at !== "string" ||
      classifyFreshness(holding.retrieved_at, FRESHNESS_SLAS.holdings, now) !== "fresh"
    ) return "HOLDING_PROVENANCE_UNAVAILABLE";
  }
  return null;
}

export function validateCurrentConnectionBindings(
  holdings: readonly PositionHoldingInput[],
  connections: readonly PositionConnectionInput[],
): LivePositionReason | null {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  for (const holding of holdings) {
    const connection = byId.get(holding.connection_id);
    if (
      !connection ||
      connection.provider !== holding.provider ||
      connection.status !== "linked" ||
      connection.authority !== "provider_verified" ||
      typeof connection.verified_at !== "string" ||
      !connection.verified_at
    ) return "HOLDING_PROVENANCE_UNAVAILABLE";
  }
  return null;
}

/** Coverage must bind every verified provider connection to its exact row generation. */
export function validateHoldingCoverage(
  holdings: readonly PositionHoldingInput[],
  connections: readonly PositionConnectionInput[],
  coverage: readonly PositionCoverageInput[],
  now = Date.now(),
): LivePositionReason | null {
  const applicable = connections.filter((connection) =>
    (connection.provider === "plaid" || connection.provider === "public")
    && connection.status === "linked"
    && connection.authority === "provider_verified"
    && typeof connection.verified_at === "string"
    && connection.verified_at,
  );
  if (applicable.length === 0) return "HOLDING_COVERAGE_UNAVAILABLE";
  for (const connection of applicable) {
    const rows = holdings.filter((holding) =>
      holding.connection_id === connection.id
      && holding.provider === connection.provider,
    );
    const fact = coverage.find((candidate) =>
      candidate.connection_id === connection.id
      && candidate.provider === connection.provider
      && candidate.component === "holdings",
    );
    if (
      !fact
      || fact.complete !== true
      || fact.availability_status !== "available"
      || !Number.isSafeInteger(fact.record_count)
      || fact.record_count !== rows.length
      || typeof fact.generation_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fact.generation_id)
      || typeof fact.generation_hash !== "string"
      || !/^[0-9a-f]{64}$/.test(fact.generation_hash)
      || typeof fact.retrieved_at !== "string"
      || classifyFreshness(fact.retrieved_at, FRESHNESS_SLAS.holdings, now) !== "fresh"
      || rows.some((holding) => holding.generation_id !== fact.generation_id)
    ) return "HOLDING_COVERAGE_UNAVAILABLE";
  }
  return null;
}

export function quoteIsAuthoritative(
  quote: PositionQuoteInput | undefined,
  now = Date.now(),
): quote is NonNullable<PositionQuoteInput> {
  return Boolean(
    quote &&
    quote.source === "massive" &&
    typeof quote.asOf === "string" &&
    classifyFreshness(quote.asOf, FRESHNESS_SLAS.marketPrice, now) === "fresh",
  );
}

/** Bounded, shared quote fan-out for the position API and AI tool. */
export async function fetchPortfolioQuotes(
  symbols: readonly string[],
  fetchQuote: (symbol: string, signal?: AbortSignal) => Promise<NonNullable<PositionQuoteInput>>,
  deadlineMs = QUOTE_DEADLINE_MS,
  signal?: AbortSignal,
): Promise<{ quotes: Map<string, PositionQuoteInput>; reason: LivePositionReason | null }> {
  const normalized = symbols.map(normalizePositionSymbol);
  if (normalized.some((symbol) => symbol === null)) return { quotes: new Map(), reason: "INVALID_SYMBOL" };
  const unique = [...new Set(normalized as string[])];
  if (unique.length > MAX_PORTFOLIO_QUOTE_SYMBOLS) return { quotes: new Map(), reason: "PORTFOLIO_QUOTE_LIMIT_EXCEEDED" };
  const quotes = new Map<string, PositionQuoteInput>();
  const deadline = Date.now() + deadlineMs;
  for (let start = 0; start < unique.length; start += QUOTE_CONCURRENCY) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) return { quotes, reason: "QUOTE_DEADLINE_EXCEEDED" };
    const controller = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const batch = Promise.all(unique.slice(start, start + QUOTE_CONCURRENCY).map(async (symbol) => {
      try {
        return [symbol, await fetchQuote(symbol, requestSignal)] as const;
      } catch {
        return [symbol, null] as const;
      }
    }));
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      batch.then((values) => ({ completed: true as const, values })),
      new Promise<{ completed: false }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ completed: false }), remaining);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (!completed.completed) {
      controller.abort();
      return { quotes, reason: "QUOTE_DEADLINE_EXCEEDED" };
    }
    for (const [symbol, quote] of completed.values) quotes.set(symbol, quote);
  }
  return { quotes, reason: null };
}

export type LivePositionMetrics = {
  available: boolean;
  reason: LivePositionReason | null;
  sharesMicro: number | null;
  costBasisMinor: number | null;
  positionValueMinor: number | null;
  unrealizedPLMinor: number | null;
  weight: number | null;
};

function unavailable(reason: LivePositionReason, sharesMicro: number | null = null, costBasisMinor: number | null = null): LivePositionMetrics {
  return { available: false, reason, sharesMicro, costBasisMinor, positionValueMinor: null, unrealizedPLMinor: null, weight: null };
}

/**
 * Computes live position metrics only when every value in the portfolio has a
 * current USD quote. Cost basis remains historical data and is never used as a
 * substitute for a missing market value or a portfolio-weight denominator.
 */
export function calculateLivePosition(
  targetSymbol: string,
  holdings: readonly PositionHoldingInput[],
  quotes: ReadonlyMap<string, PositionQuoteInput>,
  quoteConfigured: boolean,
  coverageReason: LivePositionReason | null = null,
): LivePositionMetrics {
  const target = holdings.filter((holding) => holding.symbol === targetSymbol);
  if (target.length === 0) return unavailable("POSITION_NOT_FOUND");

  let sharesMicro = 0;
  let costBasisMinor = 0;
  for (const holding of target) {
    if (normalizeFinancialCurrency(holding.currency, "") !== "USD") {
      return unavailable("MIXED_CURRENCY_REQUIRES_FX");
    }
    const quantity = strictScaledUnits(holding.shares, MICRO_SHARES_PER_SHARE);
    const basis = strictMinorUnits(holding.cost_basis, "USD");
    if (quantity === null || quantity <= 0 || basis === null || basis < 0) return unavailable("DATA_UNAVAILABLE");
    const nextShares = addMinorUnits(sharesMicro, quantity);
    const nextBasis = addMinorUnits(costBasisMinor, basis);
    if (nextShares === null || nextBasis === null) return unavailable("DATA_UNAVAILABLE");
    sharesMicro = nextShares;
    costBasisMinor = nextBasis;
  }
  if (!quoteConfigured) return unavailable("QUOTE_NOT_CONFIGURED", sharesMicro, costBasisMinor);
  if (coverageReason) return unavailable(coverageReason, sharesMicro, costBasisMinor);

  let totalValueMinor = 0;
  let targetValueMinor: number | null = null;
  for (const holding of holdings) {
    if (normalizeFinancialCurrency(holding.currency, "") !== "USD") {
      return unavailable("MIXED_CURRENCY_REQUIRES_FX", sharesMicro, costBasisMinor);
    }
    const quantity = strictScaledUnits(holding.shares, MICRO_SHARES_PER_SHARE);
    const quote = quotes.get(holding.symbol);
    if (quantity === null || quantity <= 0) return unavailable("DATA_UNAVAILABLE", sharesMicro, costBasisMinor);
    if (!quote) return unavailable(holding.symbol === targetSymbol ? "QUOTE_UNAVAILABLE" : "PORTFOLIO_QUOTES_INCOMPLETE", sharesMicro, costBasisMinor);
    if (!quoteIsAuthoritative(quote)) return unavailable("QUOTE_PROVENANCE_INVALID", sharesMicro, costBasisMinor);
    const valueMinor = multiplyScaledQuantityByDecimalPrice(
      quantity,
      quote.price,
      MICRO_SHARES_PER_SHARE,
      "USD",
    );
    if (valueMinor === null || valueMinor <= 0) return unavailable("QUOTE_INVALID", sharesMicro, costBasisMinor);
    const nextTotal = addMinorUnits(totalValueMinor, valueMinor);
    if (nextTotal === null) return unavailable("DATA_UNAVAILABLE", sharesMicro, costBasisMinor);
    totalValueMinor = nextTotal;
    if (holding.symbol === targetSymbol) {
      targetValueMinor = addMinorUnits(targetValueMinor ?? 0, valueMinor);
      if (targetValueMinor === null) return unavailable("DATA_UNAVAILABLE", sharesMicro, costBasisMinor);
    }
  }
  if (targetValueMinor === null || totalValueMinor <= 0) return unavailable("DATA_UNAVAILABLE", sharesMicro, costBasisMinor);
  const unrealizedMinor = addMinorUnits(targetValueMinor, -costBasisMinor);
  if (unrealizedMinor === null) return unavailable("DATA_UNAVAILABLE", sharesMicro, costBasisMinor);
  return {
    available: true,
    reason: null,
    sharesMicro,
    costBasisMinor,
    positionValueMinor: targetValueMinor,
    unrealizedPLMinor: unrealizedMinor,
    weight: targetValueMinor / totalValueMinor,
  };
}
