export type ThemeMode = "dark" | "dim" | "light" | "slate";

export interface Profile {
  id: string;
  display_name: string | null;
  title: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface FundHolding {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  current_value: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FundWatchlistItem {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface FundSnapshot {
  id: string;
  user_id: string;
  net_worth: number;
  invested: number;
  cash: number;
  data_source: string;
  payload: Record<string, unknown>;
  updated_at: string;
}

export type FundTxnKind =
  | "buy"
  | "sell"
  | "dividend"
  | "deposit"
  | "withdrawal"
  | "fee";

export interface FundTransaction {
  id: string;
  user_id: string;
  kind: FundTxnKind;
  symbol: string | null;
  name: string | null;
  shares: number;
  price: number;
  amount: number;
  fee: number;
  source: "manual" | "public" | "plaid" | "import";
  note: string | null;
  executed_at: string;
  created_at: string;
}

export interface FundConnection {
  id: string;
  user_id: string;
  provider: "plaid" | "public";
  item_id: string | null;
  institution: string | null;
  mask: string | null;
  status: "linked" | "error" | "revoked";
  created_at: string;
}

export interface ConsoleWidgetRow {
  id: string;
  user_id: string;
  widget_ids: string[];
  widget_texts: Record<string, { v?: string; k?: string }>;
  sort_order: string[];
  updated_at: string;
}

export interface ScheduleEvent {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  color_class: "a" | "b" | "c";
  all_day: boolean;
  created_at: string;
  updated_at: string;
}

export interface BoardField {
  id: string;
  user_id: string;
  view_key: string;
  field_key: string;
  field_value: string;
  updated_at: string;
}
