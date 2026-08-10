import { createHash } from "node:crypto";
import type { PreparedPublicOrder } from "./publicOrderAdapter";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FundOrderIntentDraft = {
  provider: "public";
  actionClass: "FINANCIAL_EXECUTION";
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantityUnits: number;
  quantityScale: number;
  limitPriceMinor: number | null;
  referencePriceMinor: number | null;
  referencePriceSource: "manual_estimate" | "unavailable";
  estimatedNotionalMinor: number | null;
  currency: string;
  status: "not_submitted";
};

export function normalizeOrderIntentIdempotencyKey(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * Produce the exact immutable intent payload. The stable key order is part of
 * the idempotency contract: retries hash this representation and may only
 * resolve to the same row when every financially material field is identical.
 */
export function buildFundOrderIntentDraft(order: PreparedPublicOrder): FundOrderIntentDraft {
  return {
    provider: "public",
    actionClass: "FINANCIAL_EXECUTION",
    symbol: order.symbol,
    side: order.side,
    orderType: order.type,
    quantityUnits: order.quantityUnits,
    quantityScale: order.quantityScale,
    limitPriceMinor: order.limitPriceMinor,
    referencePriceMinor: order.referencePriceMinor,
    referencePriceSource: order.referencePriceMinor === null ? "unavailable" : "manual_estimate",
    estimatedNotionalMinor: order.estimatedNotionalMinor,
    currency: order.currency,
    status: "not_submitted",
  };
}

export function hashFundOrderIntentDraft(draft: FundOrderIntentDraft): string {
  return createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
}
