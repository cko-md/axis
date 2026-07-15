/**
 * Rebalance proposal — a deterministic Skill (§15.2) that computes the trades
 * needed to move a portfolio toward target weights. Pure math (no model, no
 * network): it produces PROPOSED order tickets only. Turning a proposal into a
 * real order goes through the approval kernel (FINANCIAL_EXECUTION → step-up →
 * execute); nothing here submits anything.
 */

import { sumBy, toMinorUnits } from "@/lib/fund/money";
import { buildOrderTicket, type OrderTicket } from "@/lib/orders/orderTicket";

export type RebalancePosition = { symbol: string; value: number };

export type RebalanceInput = {
  positions: RebalancePosition[];
  /** symbol -> target weight (0..1). Symbols not present target 0. */
  targets: Record<string, number>;
  /** symbol -> reference price for sizing the order. */
  prices: Record<string, number>;
};

export type RebalanceAction = {
  symbol: string;
  side: "buy" | "sell";
  currentValue: number;
  currentWeight: number;
  targetWeight: number;
  /** Absolute dollar amount to trade. */
  tradeValue: number;
  ticket: OrderTicket;
};

export type RebalanceProposal = {
  total: number;
  actions: RebalanceAction[];
  /** Symbols that drifted but were skipped (no price, or below the min trade). */
  skipped: string[];
};

const DEFAULT_DRIFT = 0.05; // 5 percentage points
const DEFAULT_MIN_TRADE = 1; // dollars

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Propose the rebalance. A symbol is traded only if it drifts beyond
 * `driftThreshold` AND the trade is worth at least `minTradeValue` AND a
 * positive reference price is available. Weights are computed on integer minor
 * units so the denominator is exact.
 */
export function proposeRebalance(
  input: RebalanceInput,
  opts: { driftThreshold?: number; minTradeValue?: number } = {},
): RebalanceProposal {
  const drift = opts.driftThreshold ?? DEFAULT_DRIFT;
  const minTrade = opts.minTradeValue ?? DEFAULT_MIN_TRADE;
  const total = sumBy(input.positions, (p) => Math.max(0, p.value));
  const totalMinor = input.positions.reduce((s, p) => s + Math.max(0, toMinorUnits(p.value)), 0);

  if (totalMinor <= 0) return { total: 0, actions: [], skipped: [] };

  const valueBySymbol = new Map<string, number>();
  for (const p of input.positions) valueBySymbol.set(p.symbol, Math.max(0, p.value));

  const symbols = new Set<string>([...valueBySymbol.keys(), ...Object.keys(input.targets)]);
  const actions: RebalanceAction[] = [];
  const skipped: string[] = [];

  for (const symbol of symbols) {
    const currentValue = valueBySymbol.get(symbol) ?? 0;
    const currentWeight = round4(Math.max(0, toMinorUnits(currentValue)) / totalMinor);
    const targetWeight = input.targets[symbol] ?? 0;
    if (Math.abs(currentWeight - targetWeight) <= drift) continue;

    const targetValue = (targetWeight * totalMinor) / 100; // minor -> major
    const deltaValue = round2(targetValue - currentValue); // + buy, - sell
    const tradeValue = Math.abs(deltaValue);
    const price = input.prices[symbol];
    if (tradeValue < minTrade || !Number.isFinite(price) || price <= 0) {
      skipped.push(symbol);
      continue;
    }

    const side = deltaValue > 0 ? "buy" : "sell";
    const quantity = round4(tradeValue / price);
    const built = buildOrderTicket({ symbol, side, quantity, referencePrice: price });
    if (!built.ok) {
      skipped.push(symbol);
      continue;
    }
    actions.push({ symbol, side, currentValue, currentWeight, targetWeight, tradeValue, ticket: built.ticket });
  }

  actions.sort((a, b) => b.tradeValue - a.tradeValue);
  return { total, actions, skipped };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
