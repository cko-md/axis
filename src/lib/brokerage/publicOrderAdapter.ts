import { fail, ok, type Result } from "@/lib/integrations/types";
import {
  buildOrderTicket,
  describeOrderTicket,
  type OrderSide,
  type OrderTicket,
  type OrderType,
} from "@/lib/orders/orderTicket";

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
  type: OrderType;
  limitPrice: number | null;
  referencePrice: number | null;
  estimatedNotional: number | null;
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

function finitePositiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

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
  const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
  const side = normalizeSide(input.side);
  const quantity = finitePositiveNumber(input.quantity);
  const type = normalizeOrderType(input.type);
  const limitPrice = finitePositiveNumber(input.limitPrice ?? input.limit_price);
  const referencePrice = finiteNonNegativeNumber(input.referencePrice ?? input.reference_price);
  const currency = typeof input.currency === "string" && input.currency.trim() ? input.currency.trim().toUpperCase() : "USD";

  if (!symbol) errors.push("symbol is required");
  if (symbol.length > 12) errors.push("symbol must be 12 characters or fewer");
  if (!side) errors.push("side must be buy or sell");
  if (quantity === null) errors.push("quantity must be > 0");
  if (!type) errors.push("type must be market or limit");
  if (type === "limit" && limitPrice === null) errors.push("limit order requires a positive limitPrice");
  if (referencePrice === null) warnings.push("referencePrice missing; estimated notional is unavailable until quote verification");

  if (errors.length > 0 || !side || quantity === null || !type) {
    return fail("invalid_request", errors.join("; "), { provider: "public", retryable: false });
  }

  let ticket: OrderTicket | null = null;
  let estimatedNotional: number | null = null;
  if (referencePrice !== null) {
    const ticketResult = buildOrderTicket({
      symbol,
      side,
      quantity,
      type,
      ...(limitPrice !== null ? { limitPrice } : {}),
      referencePrice,
      currency,
    });
    if (!ticketResult.ok) {
      return fail("invalid_request", ticketResult.errors.join("; "), { provider: "public", retryable: false });
    }
    ticket = ticketResult.ticket;
    estimatedNotional = ticket.estimatedNotional;
  }

  const summary = ticket
    ? describeOrderTicket(ticket)
    : `${side === "buy" ? "Buy" : "Sell"} ${quantity} ${symbol} (${type === "limit" ? `limit ${limitPrice}` : "market"})`;

  return ok({
    provider: "public",
    actionClass: "FINANCIAL_EXECUTION",
    requiresApproval: true,
    submitEnabled: false,
    symbol,
    side,
    quantity,
    type,
    limitPrice: type === "limit" ? limitPrice : null,
    referencePrice,
    estimatedNotional,
    currency,
    summary,
    ticket,
    warnings,
  });
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
