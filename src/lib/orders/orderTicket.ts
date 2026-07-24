/**
 * Order ticket — the deterministic, validated representation of a proposed
 * trade (program §10 Public, §2.6 deterministic execution constraints). This is
 * the DRAFT/PREP artifact only: building a ticket never submits anything. A
 * ticket becomes actionable solely through the approval kernel
 * (FINANCIAL_EXECUTION → approval → step-up → execute), and even then live
 * submission is deliberately unbuilt (no autonomous execution).
 *
 * Pure and dependency-light (uses the cent-exact money primitive) so quantity/
 * price validation and notional math are typed and unit-tested rather than done
 * by free-form reasoning.
 */

import {
  minorUnitsToDecimalString,
  multiplyScaledQuantityByDecimalPrice,
  normalizeFinancialCurrency,
  strictScaledUnits,
} from "@/lib/fund/financialTruth";

const ORDER_QUANTITY_SCALE = 1_000_000;

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export type OrderTicket = {
  symbol: string;
  side: OrderSide;
  /** Shares (> 0). */
  quantity: number;
  type: OrderType;
  /** Required for a limit order. */
  limitPrice?: number;
  /** Reference price used for the notional estimate (last/mark). */
  referencePrice: number;
  /** quantity × (limit price for a limit order, else reference price), cent-exact. */
  estimatedNotional: number;
  estimatedNotionalMinor: number;
  currency: string;
};

export type OrderTicketInput = {
  symbol: string;
  side: OrderSide;
  quantity: number;
  type?: OrderType;
  limitPrice?: number;
  referencePrice: number;
  currency?: string;
};

export type OrderTicketResult =
  | { ok: true; ticket: OrderTicket }
  | { ok: false; errors: string[] };

/**
 * Validate and build an order ticket. Returns structured errors rather than
 * throwing, so a routine can decide whether to propose it for approval or skip.
 */
export function buildOrderTicket(input: OrderTicketInput): OrderTicketResult {
  const errors: string[] = [];
  const symbol = (input.symbol ?? "").trim().toUpperCase();
  const type: OrderType = input.type ?? "market";

  if (!symbol) errors.push("symbol is required");
  if (input.side !== "buy" && input.side !== "sell") errors.push("side must be buy or sell");
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) errors.push("quantity must be > 0");
  if (type !== "market" && type !== "limit") errors.push("type must be market or limit");
  if (!Number.isFinite(input.referencePrice) || input.referencePrice < 0) {
    errors.push("referencePrice must be >= 0");
  }
  if (type === "limit" && (!Number.isFinite(input.limitPrice ?? NaN) || (input.limitPrice ?? 0) <= 0)) {
    errors.push("limit order requires a positive limitPrice");
  }
  const currency = normalizeFinancialCurrency(input.currency, "");
  if (!currency) errors.push("currency is required and must be supported");
  const quantityScaled = strictScaledUnits(input.quantity, ORDER_QUANTITY_SCALE);
  if (quantityScaled === null || quantityScaled <= 0) errors.push("quantity precision is invalid");
  if (errors.length > 0) return { ok: false, errors };

  const priceForNotional = type === "limit" ? (input.limitPrice as number) : input.referencePrice;
  const estimatedNotionalMinor = multiplyScaledQuantityByDecimalPrice(
    quantityScaled as number,
    priceForNotional,
    ORDER_QUANTITY_SCALE,
    currency as string,
  );
  if (estimatedNotionalMinor === null || estimatedNotionalMinor <= 0) {
    return { ok: false, errors: ["estimated notional is unavailable"] };
  }
  const notionalText = minorUnitsToDecimalString(estimatedNotionalMinor, currency as string);
  if (!notionalText) return { ok: false, errors: ["estimated notional is unavailable"] };

  return {
    ok: true,
    ticket: {
      symbol,
      side: input.side,
      quantity: input.quantity,
      type,
      ...(type === "limit" ? { limitPrice: input.limitPrice } : {}),
      referencePrice: input.referencePrice,
      estimatedNotional: Number(notionalText),
      estimatedNotionalMinor,
      currency: currency as string,
    },
  };
}

/** One-line human description of a ticket, for the approval summary. */
export function describeOrderTicket(t: OrderTicket): string {
  const px = t.type === "limit" ? `limit ${t.limitPrice}` : "market";
  return `${t.side === "buy" ? "Buy" : "Sell"} ${t.quantity} ${t.symbol} (${px})`;
}
