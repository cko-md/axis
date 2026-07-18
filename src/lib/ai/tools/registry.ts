import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { getPlaidCreds, plaidHost } from "@/app/api/plaid/_lib";
import { fetchNews, fetchSnapshot, getPolygonApiKey, searchTickers } from "@/lib/massive/client";

/**
 * FIN-501: typed read-only adapters around code that already exists
 * elsewhere (financeDailyJobs, the /api/fund/* routes, the Massive client).
 * No new business logic lives here — only wrapping. This is the only
 * surface the Advisor (FIN-502) can reach; there is no write tool and no
 * trade tool in this file, by design (Phase 5 safety rule: the model
 * cannot call what isn't in its tool list).
 */

export type ToolContext = {
  supabase: SupabaseClient;
  userId: string;
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/** Errors returned to the model must never contain provider or database text. */
export class ToolExecutionError extends Error {
  constructor(public readonly code: "DATA_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "INVALID_INPUT") {
    super(code);
    this.name = "ToolExecutionError";
  }
}

async function fetchPlaidAccounts(
  accessToken: string,
): Promise<Array<{ name: string; mask: string | null; type: string; balance: number }>> {
  const creds = getPlaidCreds();
  if (!creds) throw new ToolExecutionError("PROVIDER_UNAVAILABLE");
  const res = await fetch(`${plaidHost(creds.env)}/accounts/balance/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, access_token: accessToken }),
  });
  if (!res.ok) throw new ToolExecutionError("PROVIDER_UNAVAILABLE");
  let data: { accounts?: unknown };
  try {
    data = (await res.json()) as { accounts?: unknown };
  } catch {
    throw new ToolExecutionError("PROVIDER_UNAVAILABLE");
  }
  const accounts = (data.accounts ?? []) as Array<{
    name: string;
    mask: string | null;
    type: string;
    balances?: { current?: number };
  }>;
  return accounts.map((a) => ({ name: a.name, mask: a.mask, type: a.type, balance: a.balances?.current ?? 0 }));
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_net_worth_history",
    description: "Net worth snapshots over time (cash, invested, liabilities, net worth), most recent first.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max snapshots to return, default 30" } },
    },
  },
  {
    name: "get_spending_by_category",
    description: "Spend (negative bank transaction amounts) grouped by category over a date range. Excludes transfers.",
    input_schema: {
      type: "object",
      properties: {
        range_days: { type: "number", description: "Lookback window in days, default 30" },
        category: { type: "string", description: "Filter to one category (custom_category or plaid_category); omit for all" },
      },
    },
  },
  {
    name: "get_budget_status",
    description: "User-set monthly budget limits per category vs. actual spend so far this calendar month.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_recurring_transactions",
    description: "Detected or manually declared recurring charges (subscriptions, bills) with cadence and next expected date.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "cancelled", "irregular"], description: "Filter by status; omit for all" },
      },
    },
  },
  {
    name: "get_holdings",
    description: "Investment holdings aggregated by symbol across sources (manual/plaid/public), with shares and cost basis.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Filter to one ticker; omit for all holdings" } },
    },
  },
  {
    name: "get_position",
    description: "Detail on one ticker: shares, cost basis, live quote (if Polygon configured), unrealized P/L, portfolio weight.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker symbol" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_liabilities",
    description: "Credit cards, loans, and other debts: balance, APR, minimum payment, due date.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_cash_accounts",
    description: "Live bank account balances from all linked Plaid connections.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_market_quote",
    description: "Latest available price and day change percent for a ticker (live if Polygon configured).",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker symbol" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_market_news",
    description: "Recent news headlines for one or more tickers.",
    input_schema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Tickers to fetch news for" },
        limit: { type: "number", description: "Max articles, default 6" },
      },
    },
  },
  {
    name: "get_watchlist",
    description: "Tickers the user is watching but does not (necessarily) hold.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_tickers",
    description: "Search for a ticker symbol by company name or partial symbol.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search text" } },
      required: ["query"],
    },
  },
  {
    name: "compute_safe_to_invest",
    description:
      "Cash on hand minus bills/subscriptions expected in the next 14 days minus an optional safety buffer. Use this for any 'can I afford'/'is it safe to invest' question — never estimate it from memory.",
    input_schema: {
      type: "object",
      properties: { buffer: { type: "number", description: "Extra safety margin to hold back, default 0" } },
    },
  },
];

// Terminal tool the model must call to close out any turn containing a
// quantitative claim — see Phase 5 "citation contract". No DB access;
// calling it IS the response, enforced by the route via tool_choice.
export const CITATION_TOOL: ToolDef = {
  name: "respond_with_citation",
  description:
    "Ends your turn with a cited answer. Call this whenever your response states a number — every number must trace back to a tool result from this conversation.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "The answer, in plain language" },
      data_sources: { type: "array", items: { type: "string" }, description: "Which tools/data this answer relied on" },
      assumptions: { type: "string", description: "Any assumptions made (e.g. data freshness, simplifications)" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      requires_review: { type: "boolean", description: "True if a human should double-check this before acting on it" },
    },
    required: ["summary", "data_sources", "assumptions", "confidence", "requires_review"],
  },
};

type Handler = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async get_net_worth_history({ supabase, userId }, input) {
    const limit = Number(input.limit ?? 30);
    const { data, error } = await supabase
      .from("net_worth_snapshots")
      .select("captured_on, cash, invested, liabilities, net_worth")
      .eq("user_id", userId)
      .order("captured_on", { ascending: false })
      .limit(Number.isFinite(limit) ? limit : 30);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return { snapshots: data ?? [] };
  },

  async get_spending_by_category({ supabase, userId }, input) {
    const rangeDays = Number(input.range_days ?? 30);
    const since = new Date(Date.now() - (Number.isFinite(rangeDays) ? rangeDays : 30) * 86400000)
      .toISOString()
      .slice(0, 10);
    let query = supabase
      .from("fund_bank_transactions")
      .select("custom_category, plaid_category, amount, posted_date")
      .eq("user_id", userId)
      .eq("is_transfer", false)
      .eq("excluded_from_budget", false)
      .lt("amount", 0)
      .gte("posted_date", since);
    const category = input.category ? String(input.category) : null;
    if (category) {
      query = query.or(`custom_category.eq.${category},plaid_category.eq.${category}`);
    }
    const { data, error } = await query;
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const byCategory = new Map<string, number>();
    for (const t of data ?? []) {
      const cat = t.custom_category ?? t.plaid_category ?? "uncategorized";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + Math.abs(Number(t.amount)));
    }
    return {
      range_days: rangeDays,
      since,
      by_category: [...byCategory.entries()].map(([category, total]) => ({ category, total })),
    };
  },

  async get_budget_status({ supabase, userId }) {
    const monthStart = new Date();
    monthStart.setDate(1);
    const since = monthStart.toISOString().slice(0, 10);

    const [{ data: budgets, error: budgetErr }, { data: txns, error: txnErr }] = await Promise.all([
      supabase.from("fund_category_budgets").select("category, monthly_limit").eq("user_id", userId),
      supabase
        .from("fund_bank_transactions")
        .select("custom_category, plaid_category, amount")
        .eq("user_id", userId)
        .eq("is_transfer", false)
        .eq("excluded_from_budget", false)
        .lt("amount", 0)
        .gte("posted_date", since),
    ]);
    if (budgetErr || txnErr) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const spendByCategory = new Map<string, number>();
    for (const t of txns ?? []) {
      const cat = t.custom_category ?? t.plaid_category ?? "uncategorized";
      spendByCategory.set(cat, (spendByCategory.get(cat) ?? 0) + Math.abs(Number(t.amount)));
    }

    return {
      month_to_date_since: since,
      budgets: (budgets ?? []).map((b) => ({
        category: b.category,
        monthly_limit: Number(b.monthly_limit),
        spent_so_far: spendByCategory.get(b.category) ?? 0,
      })),
    };
  },

  async get_recurring_transactions({ supabase, userId }, input) {
    let query = supabase
      .from("fund_recurring_transactions")
      .select("merchant_name, category, expected_amount, cadence, next_expected_date, last_seen_date, status, source")
      .eq("user_id", userId)
      .order("next_expected_date");
    if (input.status) query = query.eq("status", String(input.status));
    const { data, error } = await query;
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return { recurring: data ?? [] };
  },

  async get_holdings({ supabase, userId }, input) {
    const { data, error } = await supabase
      .from("fund_holdings")
      .select("symbol, name, shares, cost_basis, source")
      .eq("user_id", userId);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const bySymbol = new Map<string, { symbol: string; name: string; shares: number; cost_basis: number; sources: string[] }>();
    for (const r of data ?? []) {
      const existing = bySymbol.get(r.symbol);
      if (existing) {
        existing.shares += Number(r.shares);
        existing.cost_basis += Number(r.cost_basis);
        if (!existing.sources.includes(r.source)) existing.sources.push(r.source);
      } else {
        bySymbol.set(r.symbol, { symbol: r.symbol, name: r.name, shares: Number(r.shares), cost_basis: Number(r.cost_basis), sources: [r.source] });
      }
    }
    const symbolFilter = input.symbol ? String(input.symbol).toUpperCase() : null;
    const aggregated = [...bySymbol.values()].filter((h) => !symbolFilter || h.symbol === symbolFilter);
    return { holdings: aggregated };
  },

  async get_position({ supabase, userId }, input) {
    const symbol = String(input.symbol ?? "").toUpperCase();
    if (!symbol) throw new ToolExecutionError("INVALID_INPUT");

    const { data: holdings, error } = await supabase
      .from("fund_holdings")
      .select("shares, cost_basis, source")
      .eq("user_id", userId)
      .eq("symbol", symbol);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const { data: allHoldings } = await supabase.from("fund_holdings").select("symbol, shares, cost_basis").eq("user_id", userId);

    const shares = (holdings ?? []).reduce((s, h) => s + Number(h.shares), 0);
    const costBasis = (holdings ?? []).reduce((s, h) => s + Number(h.cost_basis), 0);
    const sources = [...new Set((holdings ?? []).map((h) => h.source))];

    let quote: { price: number; chg: number } | null = null;
    if (getPolygonApiKey()) {
      try {
        quote = await fetchSnapshot(symbol);
      } catch {
        // quote stays null — caller must treat as unavailable, not zero
      }
    }

    const positionValue = shares * (quote?.price ?? (shares ? costBasis / shares : 0));
    const totalPortfolioValue = (allHoldings ?? []).reduce((sum, h) => {
      const v = quote && h.symbol === symbol ? Number(h.shares) * quote.price : Number(h.cost_basis);
      return sum + v;
    }, 0);

    return {
      symbol,
      shares,
      cost_basis: costBasis,
      sources,
      quote,
      quote_available: !!quote,
      unrealized_pl: positionValue - costBasis,
      weight: totalPortfolioValue ? positionValue / totalPortfolioValue : 0,
    };
  },

  async get_liabilities({ supabase, userId }) {
    const { data, error } = await supabase
      .from("fund_liabilities")
      .select("name, kind, balance, apr, minimum_payment, due_date, source")
      .eq("user_id", userId);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return { liabilities: data ?? [] };
  },

  async get_cash_accounts({ supabase, userId }) {
    const { data: connections, error } = await supabase
      .from("fund_connections")
      .select("access_token_enc")
      .eq("user_id", userId)
      .eq("provider", "plaid")
      .eq("status", "linked");
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const accounts: Array<{ name: string; mask: string | null; type: string; balance: number }> = [];
    for (const c of connections ?? []) {
      if (!c.access_token_enc) continue;
      const token = decrypt(c.access_token_enc);
      if (token) accounts.push(...(await fetchPlaidAccounts(token)));
    }
    return { accounts, total_cash: accounts.reduce((s, a) => s + a.balance, 0) };
  },

  async get_market_quote(_ctx, input) {
    const symbol = String(input.symbol ?? "").toUpperCase();
    if (!symbol) throw new ToolExecutionError("INVALID_INPUT");
    if (!getPolygonApiKey()) return { symbol, available: false, reason: "POLYGON_API_KEY_NOT_CONFIGURED" };
    try {
      const quote = await fetchSnapshot(symbol);
      return { symbol, available: true, ...quote };
    } catch {
      return { symbol, available: false, reason: "QUOTE_UNAVAILABLE" };
    }
  },

  async get_market_news(_ctx, input) {
    if (!getPolygonApiKey()) return { news: [], available: false, reason: "POLYGON_API_KEY_NOT_CONFIGURED" };
    const symbols = Array.isArray(input.symbols) ? input.symbols.map((s) => String(s).toUpperCase()) : [];
    const limit = Number(input.limit ?? 6);
    try {
      const news = await fetchNews(symbols, Number.isFinite(limit) ? limit : 6);
      return { news, available: true };
    } catch {
      return { news: [], available: false, reason: "NEWS_UNAVAILABLE" };
    }
  },

  async get_watchlist({ supabase, userId }) {
    const { data, error } = await supabase.from("fund_watchlist").select("symbol, name").eq("user_id", userId).order("sort_order");
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return { watchlist: data ?? [] };
  },

  async search_tickers(_ctx, input) {
    const query = String(input.query ?? "").trim();
    if (!query) throw new ToolExecutionError("INVALID_INPUT");
    if (!getPolygonApiKey()) return { hits: [], available: false, reason: "POLYGON_API_KEY_NOT_CONFIGURED" };
    try {
      const hits = await searchTickers(query);
      return { hits, available: true };
    } catch {
      return { hits: [], available: false, reason: "SEARCH_UNAVAILABLE" };
    }
  },

  async compute_safe_to_invest({ supabase, userId }, input) {
    const buffer = Number(input.buffer ?? 0);
    const cashResult = (await handlers.get_cash_accounts({ supabase, userId }, {})) as { total_cash: number };

    const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const { data: bills, error } = await supabase
      .from("fund_recurring_transactions")
      .select("merchant_name, expected_amount, next_expected_date")
      .eq("user_id", userId)
      .eq("status", "active")
      .gte("next_expected_date", today)
      .lte("next_expected_date", horizon);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const upcomingBills = (bills ?? []).reduce((sum, b) => sum + Number(b.expected_amount), 0);
    const safeBuffer = Number.isFinite(buffer) ? buffer : 0;
    const safeToInvest = cashResult.total_cash - upcomingBills - safeBuffer;

    return {
      cash_on_hand: cashResult.total_cash,
      upcoming_bills_next_14_days: upcomingBills,
      buffer: safeBuffer,
      safe_to_invest: safeToInvest,
      bills_counted: bills ?? [],
    };
  },
};

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) throw new ToolExecutionError("INVALID_INPUT");
  return handler(ctx, input);
}
