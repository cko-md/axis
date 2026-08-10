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
  multiplyScaledMinorUnits,
  multiplyScaledQuantityByDecimalPrice,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactMinorUnits,
  strictExactScaledUnits,
} from "@/lib/fund/financialTruth";

const ORDER_QUANTITY_SCALE = 1_000_000;

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export type OrderTicket = {
  symbol: string;
  side: OrderSide;
  /** Shares (> 0). */
  quantity: number;
  quantityUnits: number;
  quantityScale: number;
  quantityText: string;
  type: OrderType;
  /** Required for a limit order. */
  limitPrice?: number;
  limitPriceMinor?: number;
  limitPriceText?: string;
  /** Reference price used for the notional estimate (last/mark). */
  referencePrice: number | null;
  /** quantity × (limit price for a limit order, else reference price), cent-exact. */
  estimatedNotional: number;
  estimatedNotionalText: string;
  estimatedNotionalMinor: number;
  currency: string;
};

export type OrderTicketInput = {
  symbol: string;
  side: OrderSide;
  quantity: number;
  quantityUnits?: number;
  quantityScale?: number;
  type?: OrderType;
  limitPrice?: number;
  limitPriceMinor?: number;
  referencePrice?: number | null;
  referencePriceMinor?: number | null;
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
  if (
    type === "market"
    && (!Number.isFinite(input.referencePrice) || (input.referencePrice ?? -1) < 0)
  ) {
    errors.push("referencePrice must be >= 0");
  }
  if (
    type === "limit"
    && input.referencePrice !== undefined
    && input.referencePrice !== null
    && (!Number.isFinite(input.referencePrice) || input.referencePrice < 0)
  ) errors.push("referencePrice must be >= 0 when provided");
  if (type === "limit" && (!Number.isFinite(input.limitPrice ?? NaN) || (input.limitPrice ?? 0) <= 0)) {
    errors.push("limit order requires a positive limitPrice");
  }
  const currency = normalizeFinancialCurrency(input.currency, "");
  if (!currency) errors.push("currency is required and must be supported");
  const quantityScale = input.quantityScale ?? ORDER_QUANTITY_SCALE;
  const compatibilityQuantity = strictExactScaledUnits(input.quantity, quantityScale);
  const quantityScaled = input.quantityUnits ?? compatibilityQuantity;
  if (quantityScaled === null || quantityScaled <= 0) errors.push("quantity precision is invalid");
  if (input.quantityUnits !== undefined && compatibilityQuantity !== input.quantityUnits) {
    errors.push("quantity and quantityUnits disagree");
  }
  if (currency && input.limitPriceMinor !== undefined && strictExactMinorUnits(input.limitPrice, currency) !== input.limitPriceMinor) {
    errors.push("limitPrice and limitPriceMinor disagree");
  }
  if (currency && input.referencePriceMinor !== undefined && input.referencePriceMinor !== null && strictExactMinorUnits(input.referencePrice, currency) !== input.referencePriceMinor) {
    errors.push("referencePrice and referencePriceMinor disagree");
  }
  const quantityText = quantityScaled === null ? null : scaledUnitsToDecimalString(quantityScaled, quantityScale);
  if (!quantityText) errors.push("quantity representation is unavailable");
  if (errors.length > 0) return { ok: false, errors };

  const priceForNotional = type === "limit" ? (input.limitPrice as number) : (input.referencePrice as number);
  const exactPriceMinor = type === "limit" ? input.limitPriceMinor : input.referencePriceMinor;
  const estimatedNotionalMinor = exactPriceMinor !== undefined && exactPriceMinor !== null
    ? multiplyScaledMinorUnits(quantityScaled as number, exactPriceMinor, quantityScale)
    : multiplyScaledQuantityByDecimalPrice(
        quantityScaled as number,
        priceForNotional,
        quantityScale,
        currency as string,
      );
  if (estimatedNotionalMinor === null || estimatedNotionalMinor <= 0) {
    return { ok: false, errors: ["estimated notional is unavailable"] };
  }
  const notionalText = minorUnitsToDecimalString(estimatedNotionalMinor, currency as string);
  if (!notionalText) return { ok: false, errors: ["estimated notional is unavailable"] };
  const estimatedNotional = Number(notionalText);
  if (strictExactMinorUnits(estimatedNotional, currency as string) !== estimatedNotionalMinor) {
    return { ok: false, errors: ["estimated notional is outside the exact numeric compatibility range"] };
  }

  return {
    ok: true,
    ticket: {
      symbol,
      side: input.side,
      quantity: input.quantity,
      quantityUnits: quantityScaled as number,
      quantityScale,
      quantityText: quantityText as string,
      type,
      ...(type === "limit" ? {
        limitPrice: input.limitPrice,
        ...(input.limitPriceMinor !== undefined ? {
          limitPriceMinor: input.limitPriceMinor,
          limitPriceText: minorUnitsToDecimalString(input.limitPriceMinor, currency as string) ?? undefined,
        } : {}),
      } : {}),
      referencePrice: input.referencePrice ?? null,
      estimatedNotional,
      estimatedNotionalText: notionalText,
      estimatedNotionalMinor,
      currency: currency as string,
    },
  };
}

/** One-line human description of a ticket, for the approval summary. */
export function describeOrderTicket(t: OrderTicket): string {
  const px = t.type === "limit" ? `limit ${t.limitPriceText ?? t.limitPrice}` : "market";
  return `${t.side === "buy" ? "Buy" : "Sell"} ${trimDecimalZeros(t.quantityText)} ${t.symbol} (${px})`;
}

function trimDecimalZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
