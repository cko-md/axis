import { toMajorUnitsIn, toMinorUnitsIn } from "./currency";

export type PortfolioValuation = {
  date: string;
  value: unknown;
  currency?: string | null;
};

/**
 * External portfolio cash flow. Positive amount = contribution into the
 * portfolio; negative amount = withdrawal out of the portfolio.
 */
export type PortfolioCashFlow = {
  date: string;
  amount: unknown;
  currency?: string | null;
};

export type PortfolioPosition = {
  key: string;
  label?: string | null;
  value: unknown;
  currency?: string | null;
};

export type PortfolioPerformanceErrorCode =
  | "insufficient_valuations"
  | "invalid_date"
  | "mixed_currency"
  | "non_positive_start_value"
  | "invalid_period_value"
  | "irr_not_bracketed";

export type PortfolioPerformanceError = {
  code: PortfolioPerformanceErrorCode;
  message: string;
};

export type PerformanceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PortfolioPerformanceError };

export type TimeWeightedReturn = {
  currency: string;
  startDate: string;
  endDate: string;
  startValueMinor: number;
  endValueMinor: number;
  externalFlowMinor: number;
  periodReturns: { startDate: string; endDate: string; flowMinor: number; return: number }[];
  return: number;
};

export type MoneyWeightedReturn = {
  currency: string;
  startDate: string;
  endDate: string;
  startValueMinor: number;
  endValueMinor: number;
  externalFlowMinor: number;
  cashFlows: { date: string; amountMinor: number }[];
  annualizedReturn: number;
};

export type AllocationSlice = {
  key: string;
  label: string;
  valueMinor: number;
  value: number;
  currency: string;
  weight: number;
};

export type AllocationBreakdown = {
  currency: string;
  totalMinor: number;
  total: number;
  slices: AllocationSlice[];
};

type NormalizedValuation = {
  date: string;
  time: number;
  valueMinor: number;
  currency: string;
};

type NormalizedFlow = {
  date: string;
  time: number;
  amountMinor: number;
  currency: string;
};

const DEFAULT_CURRENCY = "USD";
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MAX_IRR_ITERATIONS = 120;
const IRR_TOLERANCE = 1e-10;

function fail<T = never>(code: PortfolioPerformanceErrorCode, message: string): PerformanceResult<T> {
  return { ok: false, error: { code, message } };
}

function normalizeCurrency(currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toUpperCase();
  return code === "" ? DEFAULT_CURRENCY : code;
}

function parseDate(date: string): number | null {
  const time = Date.parse(date);
  return Number.isFinite(time) ? time : null;
}

function roundRate(rate: number): number {
  if (!Number.isFinite(rate)) return rate;
  return Math.round(rate * 100_000_000) / 100_000_000;
}

function normalizeValuations(valuations: readonly PortfolioValuation[]): PerformanceResult<NormalizedValuation[]> {
  if (valuations.length < 2) {
    return fail("insufficient_valuations", "At least two portfolio valuations are required.");
  }
  const normalized: NormalizedValuation[] = [];
  for (const valuation of valuations) {
    const time = parseDate(valuation.date);
    if (time === null) return fail("invalid_date", `Invalid valuation date: ${valuation.date}.`);
    const currency = normalizeCurrency(valuation.currency);
    normalized.push({
      date: valuation.date,
      time,
      valueMinor: toMinorUnitsIn(valuation.value, currency),
      currency,
    });
  }
  normalized.sort((a, b) => a.time - b.time);
  const currency = normalized[0].currency;
  if (normalized.some((valuation) => valuation.currency !== currency)) {
    return fail("mixed_currency", "Portfolio returns require one currency or explicit FX conversion before calculation.");
  }
  return { ok: true, value: normalized };
}

function normalizeCashFlows(
  cashFlows: readonly PortfolioCashFlow[],
  expectedCurrency: string,
): PerformanceResult<NormalizedFlow[]> {
  const normalized: NormalizedFlow[] = [];
  for (const flow of cashFlows) {
    const time = parseDate(flow.date);
    if (time === null) return fail("invalid_date", `Invalid cash-flow date: ${flow.date}.`);
    const currency = normalizeCurrency(flow.currency);
    if (currency !== expectedCurrency) {
      return fail("mixed_currency", "Cash flows must match the portfolio valuation currency before return calculation.");
    }
    normalized.push({
      date: flow.date,
      time,
      amountMinor: toMinorUnitsIn(flow.amount, currency),
      currency,
    });
  }
  normalized.sort((a, b) => a.time - b.time);
  return { ok: true, value: normalized };
}

export function calculateTimeWeightedReturn(
  valuations: readonly PortfolioValuation[],
  cashFlows: readonly PortfolioCashFlow[] = [],
): PerformanceResult<TimeWeightedReturn> {
  const normalizedValuations = normalizeValuations(valuations);
  if (!normalizedValuations.ok) return normalizedValuations;
  const orderedValuations = normalizedValuations.value;
  const currency = orderedValuations[0].currency;
  const normalizedFlows = normalizeCashFlows(cashFlows, currency);
  if (!normalizedFlows.ok) return normalizedFlows;
  const flows = normalizedFlows.value;

  let compounded = 1;
  const periodReturns: TimeWeightedReturn["periodReturns"] = [];
  let externalFlowMinor = 0;

  for (let i = 1; i < orderedValuations.length; i += 1) {
    const start = orderedValuations[i - 1];
    const end = orderedValuations[i];
    if (start.valueMinor <= 0) {
      return fail("non_positive_start_value", "Time-weighted return requires each period to start with a positive value.");
    }
    if (end.time <= start.time) {
      return fail("invalid_date", "Portfolio valuations must have strictly increasing dates.");
    }
    if (end.valueMinor < 0) {
      return fail("invalid_period_value", "Portfolio valuation cannot be negative.");
    }

    const flowMinor = flows
      .filter((flow) => flow.time > start.time && flow.time <= end.time)
      .reduce((sum, flow) => sum + flow.amountMinor, 0);
    externalFlowMinor += flowMinor;
    const periodReturn = (end.valueMinor - start.valueMinor - flowMinor) / start.valueMinor;
    compounded *= 1 + periodReturn;
    periodReturns.push({
      startDate: start.date,
      endDate: end.date,
      flowMinor,
      return: roundRate(periodReturn),
    });
  }

  return {
    ok: true,
    value: {
      currency,
      startDate: orderedValuations[0].date,
      endDate: orderedValuations[orderedValuations.length - 1].date,
      startValueMinor: orderedValuations[0].valueMinor,
      endValueMinor: orderedValuations[orderedValuations.length - 1].valueMinor,
      externalFlowMinor,
      periodReturns,
      return: roundRate(compounded - 1),
    },
  };
}

export function calculateMoneyWeightedReturn(
  valuations: readonly PortfolioValuation[],
  cashFlows: readonly PortfolioCashFlow[] = [],
): PerformanceResult<MoneyWeightedReturn> {
  const normalizedValuations = normalizeValuations(valuations);
  if (!normalizedValuations.ok) return normalizedValuations;
  const orderedValuations = normalizedValuations.value;
  const currency = orderedValuations[0].currency;
  const normalizedFlows = normalizeCashFlows(cashFlows, currency);
  if (!normalizedFlows.ok) return normalizedFlows;
  const start = orderedValuations[0];
  const end = orderedValuations[orderedValuations.length - 1];
  if (start.valueMinor <= 0) {
    return fail("non_positive_start_value", "Money-weighted return requires a positive starting value.");
  }
  if (end.time <= start.time) {
    return fail("invalid_date", "Portfolio valuations must have strictly increasing dates.");
  }

  const inWindowFlows = normalizedFlows.value.filter((flow) => flow.time > start.time && flow.time <= end.time);
  const investorCashFlows = [
    { time: start.time, amountMinor: -start.valueMinor },
    ...inWindowFlows.map((flow) => ({ time: flow.time, amountMinor: -flow.amountMinor })),
    { time: end.time, amountMinor: end.valueMinor },
  ];

  const hasPositive = investorCashFlows.some((flow) => flow.amountMinor > 0);
  const hasNegative = investorCashFlows.some((flow) => flow.amountMinor < 0);
  if (!hasPositive || !hasNegative) {
    return fail("irr_not_bracketed", "Money-weighted return requires at least one inflow and one outflow.");
  }

  const npv = (rate: number): number => {
    let total = 0;
    for (const flow of investorCashFlows) {
      const years = (flow.time - start.time) / MS_PER_YEAR;
      total += flow.amountMinor / (1 + rate) ** years;
    }
    return total;
  };

  let low = -0.999999;
  let high = 10;
  let lowNpv = npv(low);
  let highNpv = npv(high);
  while (lowNpv * highNpv > 0 && high < 1_000_000) {
    high *= 10;
    highNpv = npv(high);
  }
  if (lowNpv * highNpv > 0) {
    return fail("irr_not_bracketed", "Could not bracket a money-weighted return for the supplied cash flows.");
  }

  let mid = 0;
  for (let i = 0; i < MAX_IRR_ITERATIONS; i += 1) {
    mid = (low + high) / 2;
    const midNpv = npv(mid);
    if (Math.abs(midNpv) < IRR_TOLERANCE) break;
    if (lowNpv * midNpv <= 0) {
      high = mid;
      highNpv = midNpv;
    } else {
      low = mid;
      lowNpv = midNpv;
    }
  }

  return {
    ok: true,
    value: {
      currency,
      startDate: start.date,
      endDate: end.date,
      startValueMinor: start.valueMinor,
      endValueMinor: end.valueMinor,
      externalFlowMinor: inWindowFlows.reduce((sum, flow) => sum + flow.amountMinor, 0),
      cashFlows: inWindowFlows.map((flow) => ({ date: flow.date, amountMinor: flow.amountMinor })),
      annualizedReturn: roundRate(mid),
    },
  };
}

export function calculateAllocation(
  positions: readonly PortfolioPosition[],
): PerformanceResult<AllocationBreakdown> {
  const normalized = positions.map((position) => {
    const currency = normalizeCurrency(position.currency);
    return {
      key: position.key,
      label: position.label?.trim() || position.key,
      currency,
      valueMinor: Math.max(0, toMinorUnitsIn(position.value, currency)),
    };
  });
  const currency = normalized[0]?.currency ?? DEFAULT_CURRENCY;
  if (normalized.some((position) => position.currency !== currency)) {
    return fail("mixed_currency", "Allocation requires one currency or explicit FX conversion before calculation.");
  }
  const totalMinor = normalized.reduce((sum, position) => sum + position.valueMinor, 0);
  const slices = normalized
    .map((position) => ({
      ...position,
      value: toMajorUnitsIn(position.valueMinor, currency),
      weight: totalMinor > 0 ? roundRate(position.valueMinor / totalMinor) : 0,
    }))
    .sort((a, b) => b.valueMinor - a.valueMinor);

  return {
    ok: true,
    value: {
      currency,
      totalMinor,
      total: toMajorUnitsIn(totalMinor, currency),
      slices,
    },
  };
}
