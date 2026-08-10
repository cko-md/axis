import { fail, ok, type Result } from "@/lib/integrations/types";
import {
  buildOrderTicket,
  describeOrderTicket,
  type OrderSide,
  type OrderTicket,
  type OrderType,
} from "@/lib/orders/orderTicket";
import {
  multiplyScaledMinorUnits,
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactScaledUnits,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";
import { toMajorUnitsIn } from "@/lib/fund/currency";
import { normalizeUsEquitySymbol } from "@/lib/fund/equitySymbol";

export const PUBLIC_ORDER_QUANTITY_SCALE = 1_000_000;

export type PublicOrderAction = "prepare" | "verify" | "submit";

export type PublicOrderInput = {
  symbol: unknown;
  side: unknown;
  quantity: unknown;
  type?: unknown;
  limitPrice?: unknown;
  limit_price?: unknown;
  referencePrice?: unknown;
  reference_price?: unknown;
  currency?: unknown;
};

export type PreparedPublicOrder = {
  provider: "public";
  actionClass: "FINANCIAL_EXECUTION";
  requiresApproval: true;
  submitEnabled: false;
  symbol: string;
  side: OrderSide;
  quantity: number;
  quantityText: string;
  quantityUnits: number;
  quantityScale: typeof PUBLIC_ORDER_QUANTITY_SCALE;
  type: OrderType;
  limitPrice: number | null;
  limitPriceMinor: number | null;
  referencePrice: number | null;
  referencePriceMinor: number | null;
  estimatedNotional: number | null;
  estimatedNotionalMinor: number | null;
  currency: string;
  summary: string;
  ticket: OrderTicket | null;
  warnings: string[];
};

export type PublicOrderVerification = {
  preparedOrder: PreparedPublicOrder;
  brokerageConfigured: boolean;
  accountConfigured: boolean;
  approvalRequired: true;
  stepUpRequired: true;
  submitEnabled: false;
  message: string;
};

export type PublicOrderSubmitClearance = {
  approvalId: string;
  serverVerified: boolean;
};

function normalizeOrderType(value: unknown): OrderType | null {
  if (value === undefined || value === null || value === "") return "market";
  return value === "market" || value === "limit" ? value : null;
}

function normalizeSide(value: unknown): OrderSide | null {
  return value === "buy" || value === "sell" ? value : null;
}

export function preparePublicOrder(input: PublicOrderInput): Result<PreparedPublicOrder> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const symbol = normalizeUsEquitySymbol(input.symbol) ?? "";
  const side = normalizeSide(input.side);
  const quantityUnits = strictExactScaledUnits(input.quantity, PUBLIC_ORDER_QUANTITY_SCALE);
  const quantity = quantityUnits === null ? null : quantityUnits / PUBLIC_ORDER_QUANTITY_SCALE;
  const quantityText = quantityUnits === null
    ? null
    : scaledUnitsToDecimalString(quantityUnits, PUBLIC_ORDER_QUANTITY_SCALE);
  const type = normalizeOrderType(input.type);
  const currency = normalizeFinancialCurrency(input.currency, "") ?? "";
  const rawLimitPrice = input.limitPrice ?? input.limit_price;
  const rawReferencePrice = input.referencePrice ?? input.reference_price;
  const limitPriceMinor = rawLimitPrice === undefined || rawLimitPrice === null || rawLimitPrice === ""
    ? null
    : strictExactMinorUnits(rawLimitPrice, currency);
  const referencePriceMinor = rawReferencePrice === undefined || rawReferencePrice === null || rawReferencePrice === ""
    ? null
    : strictExactMinorUnits(rawReferencePrice, currency);
  const limitPrice = limitPriceMinor === null ? null : toMajorUnitsIn(limitPriceMinor, currency);
  const referencePrice = referencePriceMinor === null ? null : toMajorUnitsIn(referencePriceMinor, currency);
  const quantityRoundTrip = quantity === null
    ? null
    : strictExactScaledUnits(quantity, PUBLIC_ORDER_QUANTITY_SCALE);
  const limitPriceRoundTrip = limitPrice === null ? null : strictExactMinorUnits(limitPrice, currency);
  const referencePriceRoundTrip = referencePrice === null ? null : strictExactMinorUnits(referencePrice, currency);

  if (!symbol) errors.push("symbol must be a canonical US equity ticker");
  if (!side) errors.push("side must be buy or sell");
  if (quantity === null || quantityUnits === null || quantityUnits <= 0) {
    errors.push("quantity must be > 0 with at most 6 decimal places");
  } else if (quantityRoundTrip !== quantityUnits) {
    errors.push("quantity is outside the exact numeric compatibility range");
  }
  if (!type) errors.push("type must be market or limit");
  if (!currency) errors.push("currency is required");
  if (type === "limit" && (limitPriceMinor === null || limitPriceMinor <= 0)) {
    errors.push("limit order requires a positive cent-exact limitPrice");
  } else if (type === "limit" && limitPriceRoundTrip !== limitPriceMinor) {
    errors.push("limitPrice is outside the exact numeric compatibility range");
  }
  if (rawReferencePrice !== undefined && rawReferencePrice !== null && rawReferencePrice !== "" && referencePriceMinor === null) {
    errors.push("referencePrice must be a non-negative cent-exact amount");
  } else if (referencePriceMinor !== null && referencePriceRoundTrip !== referencePriceMinor) {
    errors.push("referencePrice is outside the exact numeric compatibility range");
  }
  if (referencePrice === null && type === "market") {
    warnings.push("referencePrice missing; estimated notional is unavailable until quote verification");
  } else if (referencePrice === null && type === "limit") {
    warnings.push("referencePrice missing; limit-to-market comparison is unavailable until quote verification");
  }

  if (errors.length > 0 || !side || quantity === null || quantityUnits === null || !quantityText || !type) {
    return fail("invalid_request", errors.join("; "), { provider: "public", retryable: false });
  }

  let ticket: OrderTicket | null = null;
  let estimatedNotional: number | null = null;
  let estimatedNotionalMinor: number | null = null;
  const notionalPriceMinor = type === "limit" ? limitPriceMinor : referencePriceMinor;
  if (notionalPriceMinor !== null) {
    estimatedNotionalMinor = multiplyScaledMinorUnits(
      quantityUnits,
      notionalPriceMinor,
      PUBLIC_ORDER_QUANTITY_SCALE,
    );
    if (estimatedNotionalMinor === null) {
      return fail("invalid_request", "estimated notional is outside the supported range", {
        provider: "public",
        retryable: false,
      });
    }
    const ticketResult = buildOrderTicket({
      symbol,
      side,
      quantity,
      quantityUnits,
      quantityScale: PUBLIC_ORDER_QUANTITY_SCALE,
      type,
      ...(limitPrice !== null ? { limitPrice } : {}),
      ...(limitPriceMinor !== null ? { limitPriceMinor } : {}),
      referencePrice,
      referencePriceMinor,
      currency,
    });
    if (!ticketResult.ok) {
      return fail("invalid_request", ticketResult.errors.join("; "), { provider: "public", retryable: false });
    }
    ticket = ticketResult.ticket;
    estimatedNotional = toMajorUnitsIn(estimatedNotionalMinor, currency);
  }

  const summary = ticket
    ? describeOrderTicket(ticket)
    : `${side === "buy" ? "Buy" : "Sell"} ${trimDecimalZeros(quantityText)} ${symbol} (${type === "limit" ? `limit ${limitPriceMinor === null ? "unavailable" : minorUnitsToDecimalString(limitPriceMinor, currency)}` : "market"})`;

  return ok({
    provider: "public",
    actionClass: "FINANCIAL_EXECUTION",
    requiresApproval: true,
    submitEnabled: false,
    symbol,
    side,
    quantity,
    quantityText,
    quantityUnits,
    quantityScale: PUBLIC_ORDER_QUANTITY_SCALE,
    type,
    limitPrice: type === "limit" ? limitPrice : null,
    limitPriceMinor: type === "limit" ? limitPriceMinor : null,
    referencePrice,
    referencePriceMinor,
    estimatedNotional,
    estimatedNotionalMinor,
    currency,
    summary,
    ticket,
    warnings,
  });
}

function trimDecimalZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export function verifyPublicOrder(
  input: PublicOrderInput,
  options: { brokerageConfigured: boolean; accountConfigured: boolean },
): Result<PublicOrderVerification> {
  const prepared = preparePublicOrder(input);
  if (!prepared.ok) return prepared;

  return ok({
    preparedOrder: prepared.data,
    brokerageConfigured: options.brokerageConfigured,
    accountConfigured: options.accountConfigured,
    approvalRequired: true,
    stepUpRequired: true,
    submitEnabled: false,
    message: options.brokerageConfigured && options.accountConfigured
      ? "Public credentials are configured, but live submission is disabled until a server-side approval execution adapter is implemented."
      : "Public credentials are incomplete; this order can only be prepared for review.",
  });
}

export function submitPublicOrder(
  input: PublicOrderInput,
  clearance?: PublicOrderSubmitClearance,
): Result<never> {
  const prepared = preparePublicOrder(input);
  if (!prepared.ok) return prepared as Result<never>;

  if (!clearance?.approvalId || clearance.serverVerified !== true) {
    return fail("invalid_request", "Server-verified approval and fresh step-up are required before Public order submission.", {
      provider: "public",
      retryable: false,
    });
  }

  return fail("not_supported", "Live Public order submission is not enabled in this build.", {
    provider: "public",
    retryable: false,
  });
}
