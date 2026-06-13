export interface HoldingRow {
  id?: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  last_price?: number;
}

export interface WatchlistRow {
  id?: string;
  symbol: string;
  name: string;
  price?: number;
  chg?: number;
}

export type TxnKind =
  | "buy"
  | "sell"
  | "dividend"
  | "deposit"
  | "withdrawal"
  | "fee";

export interface TransactionRow {
  id?: string;
  kind: TxnKind;
  symbol?: string | null;
  name?: string | null;
  shares: number;
  price: number;
  amount: number; // signed cash delta
  source: "manual" | "public" | "plaid" | "import";
  note?: string | null;
  executed_at: string;
}

export const DEFAULT_TRANSACTIONS: TransactionRow[] = [
  { kind: "buy", symbol: "NVDA", name: "NVIDIA", shares: 10, price: 124.0, amount: -1240, source: "manual", executed_at: "2026-06-06" },
  { kind: "deposit", symbol: null, name: "Salary — Hospital", shares: 0, price: 0, amount: 3400, source: "plaid", executed_at: "2026-06-01" },
  { kind: "sell", symbol: "VXUS", name: "Intl ex-US", shares: 12, price: 64.5, amount: 774, source: "manual", executed_at: "2026-05-28" },
  { kind: "dividend", symbol: "VTI", name: "Total Market ETF", shares: 0, price: 0, amount: 92, source: "manual", executed_at: "2026-05-20" },
];

export const KIND_META: Record<TxnKind, { label: string; sign: 1 | -1 | 0; ic: string }> = {
  buy: { label: "Buy", sign: -1, ic: "↗" },
  sell: { label: "Sell", sign: 1, ic: "↘" },
  dividend: { label: "Dividend", sign: 1, ic: "✦" },
  deposit: { label: "Deposit", sign: 1, ic: "+" },
  withdrawal: { label: "Withdrawal", sign: -1, ic: "−" },
  fee: { label: "Fee", sign: -1, ic: "•" },
};

export function fmtSignedUsd(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export const DEFAULT_HOLDINGS: HoldingRow[] = [
  { symbol: "VTI", name: "Total Market ETF", shares: 100, cost_basis: 38100 },
  { symbol: "NVDA", name: "NVIDIA", shares: 50, cost_basis: 12400 },
  { symbol: "VXUS", name: "Intl ex-US", shares: 80, cost_basis: 18900 },
  { symbol: "BTC", name: "Bitcoin", shares: 0.28, cost_basis: 9200 },
];

export const DEFAULT_WATCHLIST: WatchlistRow[] = [
  { symbol: "TSM", name: "Taiwan Semi", price: 184.2, chg: 1.9 },
  { symbol: "COST", name: "Costco", price: 902.1, chg: 0.4 },
  { symbol: "LLY", name: "Eli Lilly", price: 812.5, chg: -0.7 },
];

export function fmtUsd(n: number) {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function fmtUsd2(n: number) {
  return "$" + n.toFixed(2);
}

export function holdingValue(h: HoldingRow) {
  const price = h.last_price ?? h.cost_basis / Math.max(h.shares, 0.001);
  return h.shares * price;
}

export function holdingGain(h: HoldingRow) {
  const val = holdingValue(h);
  if (!h.cost_basis) return 0;
  return ((val - h.cost_basis) / h.cost_basis) * 100;
}
