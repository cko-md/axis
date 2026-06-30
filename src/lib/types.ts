export type ThemeMode = "dark" | "dim" | "light" | "slate";

export type Holding = {
  id?: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  current_value: number;
  weight_pct?: number;
  last_price?: number;
  gain_pct?: number;
};

export type WatchlistItem = {
  id?: string;
  symbol: string;
  name: string;
  price?: number;
  change?: number;
};

export type ScheduleEvent = {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  attendees?: string[];
  start_at: string;
  end_at: string;
  color_class: "a" | "b" | "c" | "or";
  all_day?: boolean;
  source?: string;
};

export type WidgetCatalogItem = {
  id: string;
  icon: string;
  label: string;
  value: string;
  hint: string;
  category?: string;
  live?: boolean;
};

export type ConsoleWidgetConfig = {
  widget_ids: string[];
  widget_texts: Record<string, { v: string; k: string }>;
  sort_order: string[];
};

export type FundSnapshot = {
  net_worth: number;
  invested: number;
  cash: number;
  data_source: "simulated" | "live";
};
