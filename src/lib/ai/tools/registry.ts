import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchNews, fetchSnapshot, getPolygonApiKey, searchTickers } from "@/lib/massive/client";
import {
  calculateLivePosition,
  fetchPortfolioQuotes,
  MAX_PORTFOLIO_QUOTE_SYMBOLS,
  normalizePositionSymbol,
  quoteIsAuthoritative,
  validateAuthoritativeHoldings,
  validateCurrentConnectionBindings,
  validateHoldingCoverage,
  type PositionQuoteInput,
} from "@/lib/fund/positionTruth";
import {
  addMinorUnits,
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactMinorUnits,
  strictMinorUnits,
  strictScaledUnits,
} from "@/lib/fund/financialTruth";
import { MICRO_SHARES_PER_SHARE } from "@/lib/fund/taxLots";
import {
  detectedRecurringMatchesCoverage,
  readCompleteTransactionCoverage,
  transactionRowsMatchCoverage,
  TRANSACTION_HISTORY_DAYS,
} from "@/lib/fund/transactionCoverage";
import { classifyFreshness, FRESHNESS_SLAS } from "@/lib/fund/provenance";

function requiredUsdMinor(value: unknown, currency: unknown = "USD"): number {
  if (currency !== "USD") throw new ToolExecutionError("DATA_UNAVAILABLE");
  const minor = strictMinorUnits(value, "USD");
  if (minor === null) throw new ToolExecutionError("DATA_UNAVAILABLE");
  return minor;
}

function safeAdd(left: number, right: number): number {
  const total = addMinorUnits(left, right);
  if (total === null) throw new ToolExecutionError("DATA_UNAVAILABLE");
  return total;
}

type ProviderComponent = "holdings" | "liabilities";

async function requireProviderComponentCoverage(
  supabase: SupabaseClient,
  userId: string,
  component: ProviderComponent,
  rows: Array<{ connection_id?: unknown; provider?: unknown }>,
) {
  const [{ data: connections, error: connectionError }, { data: coverage, error: coverageError }] = await Promise.all([
    supabase
      .from("fund_connections")
      .select("id, provider, status, authority, verified_at")
      .eq("user_id", userId)
      .limit(33),
    supabase
      .from("fund_provider_coverage")
      .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason")
      .eq("user_id", userId)
      .eq("component", component)
      .limit(33),
  ]);
  if (connectionError || coverageError || (connections ?? []).length > 32 || (coverage ?? []).length > 32) {
    throw new ToolExecutionError("DATA_UNAVAILABLE");
  }
  const relevant = (connections ?? []).filter((connection) =>
    connection.status === "linked"
    && connection.authority === "provider_verified"
    && typeof connection.verified_at === "string"
    && (component === "holdings" || connection.provider === "plaid"),
  );
  if (relevant.length === 0) throw new ToolExecutionError("DATA_UNAVAILABLE");
  const connectionById = new Map(relevant.map((connection) => [connection.id, connection]));
  if (rows.some((row) =>
    typeof row.connection_id !== "string"
    || connectionById.get(row.connection_id)?.provider !== row.provider
  )) throw new ToolExecutionError("DATA_UNAVAILABLE");
  const freshness = component === "holdings"
    ? FRESHNESS_SLAS.holdings
    : FRESHNESS_SLAS.accountBalance;
  const facts = relevant.map((connection) => {
    const fact = (coverage ?? []).find((candidate) =>
      candidate.connection_id === connection.id
      && candidate.provider === connection.provider
      && candidate.component === component,
    );
    if (
      fact?.complete !== true
      || fact.availability_status !== "available"
      || classifyFreshness(fact.retrieved_at, freshness) !== "fresh"
      || fact.record_count !== rows.filter((row) => row.connection_id === connection.id).length
    ) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return fact;
  });
  return {
    authority: "provider" as const,
    component,
    complete: true as const,
    facts: facts.map((fact) => ({
      connection_id: fact.connection_id,
      provider: fact.provider,
      record_count: fact.record_count,
      retrieved_at: fact.retrieved_at,
    })),
  };
}

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
    description: "Detail on one ticker: shares and cost basis plus live quote, P/L, and weight only when current quotes cover the whole USD portfolio; unavailable metrics are null with a reason.",
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
      .from("net_worth_snapshots_exact")
      .select("captured_on, cash, invested, liabilities, net_worth, currency")
    .eq("user_id", userId)
    .eq("authority", "provider")
    .eq("snapshot_status", "fresh")
    .eq("calculation_version", "financial-truth-v2")
      .order("captured_on", { ascending: false })
      .limit(Number.isFinite(limit) ? limit : 30);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return { snapshots: data ?? [] };
  },

  async get_spending_by_category({ supabase, userId }, input) {
    const requestedRange = Number(input.range_days ?? 30);
    const rangeDays = Number.isSafeInteger(requestedRange)
      && requestedRange >= 1
      && requestedRange <= TRANSACTION_HISTORY_DAYS
      ? requestedRange
      : 30;
    const since = new Date(Date.now() - rangeDays * 86400000)
      .toISOString()
      .slice(0, 10);
    const coverage = await readCompleteTransactionCoverage(
      supabase,
      userId,
      since,
      new Date().toISOString().slice(0, 10),
    );
    if (!coverage.available) throw new ToolExecutionError("DATA_UNAVAILABLE");
    let query = supabase
      .from("fund_bank_transactions")
      .select("custom_category, plaid_category, amount, amount_minor, posted_date, iso_currency_code, connection_id, retrieved_at, generation_id, authority")
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
    if (!transactionRowsMatchCoverage(data ?? [], coverage)) {
      throw new ToolExecutionError("DATA_UNAVAILABLE");
    }

    const byCategory = new Map<string, number>();
    for (const t of data ?? []) {
      if (!t.connection_id || !t.retrieved_at) throw new ToolExecutionError("DATA_UNAVAILABLE");
      const amountMinor = requiredUsdMinor(t.amount, t.iso_currency_code);
      if (amountMinor >= 0) throw new ToolExecutionError("DATA_UNAVAILABLE");
      const cat = t.custom_category ?? t.plaid_category ?? "uncategorized";
      byCategory.set(cat, safeAdd(byCategory.get(cat) ?? 0, Math.abs(amountMinor)));
    }
    return {
      range_days: rangeDays,
      since,
      authority: "provider",
      coverage: coverage.facts,
      by_category: [...byCategory.entries()].map(([category, totalMinor]) => ({
        category,
        total: minorUnitsToDecimalString(totalMinor, "USD"),
        total_minor: totalMinor,
        currency: "USD",
      })),
    };
  },

  async get_budget_status({ supabase, userId }) {
    const monthStart = new Date();
    monthStart.setDate(1);
    const since = monthStart.toISOString().slice(0, 10);
    const coverage = await readCompleteTransactionCoverage(
      supabase,
      userId,
      since,
      new Date().toISOString().slice(0, 10),
    );
    if (!coverage.available) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const [{ data: budgets, error: budgetErr }, { data: txns, error: txnErr }] = await Promise.all([
      supabase.from("fund_category_budgets").select("category, monthly_limit, currency").eq("user_id", userId),
      supabase
        .from("fund_bank_transactions")
        .select("custom_category, plaid_category, amount, amount_minor, iso_currency_code, connection_id, retrieved_at, generation_id, authority")
        .eq("user_id", userId)
        .eq("is_transfer", false)
        .eq("excluded_from_budget", false)
        .lt("amount", 0)
        .gte("posted_date", since),
    ]);
    if (budgetErr || txnErr) throw new ToolExecutionError("DATA_UNAVAILABLE");
    if (!transactionRowsMatchCoverage(txns ?? [], coverage)) {
      throw new ToolExecutionError("DATA_UNAVAILABLE");
    }

    const spendByCategoryCurrency = new Map<string, number>();
    for (const t of txns ?? []) {
      if (!t.connection_id || !t.retrieved_at) throw new ToolExecutionError("DATA_UNAVAILABLE");
      const currency = normalizeFinancialCurrency(t.iso_currency_code, "");
      const amountMinor = currency ? strictExactMinorUnits(t.amount, currency) : null;
      if (!currency || amountMinor === null) throw new ToolExecutionError("DATA_UNAVAILABLE");
      if (amountMinor >= 0) throw new ToolExecutionError("DATA_UNAVAILABLE");
      const cat = t.custom_category ?? t.plaid_category ?? "uncategorized";
      const key = `${cat}\u0000${currency}`;
      spendByCategoryCurrency.set(
        key,
        safeAdd(spendByCategoryCurrency.get(key) ?? 0, Math.abs(amountMinor)),
      );
    }

    return {
      month_to_date_since: since,
      authority: "provider",
      coverage: coverage.facts,
      budgets: (budgets ?? []).map((b) => {
        const currency = normalizeFinancialCurrency(b.currency, "");
        const limitMinor = currency ? strictExactMinorUnits(b.monthly_limit, currency) : null;
        if (!currency || limitMinor === null) throw new ToolExecutionError("DATA_UNAVAILABLE");
        const spentMinor = spendByCategoryCurrency.get(`${b.category}\u0000${currency}`) ?? 0;
        return {
          category: b.category,
          monthly_limit: minorUnitsToDecimalString(limitMinor, currency),
          monthly_limit_minor: limitMinor,
          spent_so_far: minorUnitsToDecimalString(spentMinor, currency),
          spent_so_far_minor: spentMinor,
          currency,
        };
      }),
    };
  },

  async get_recurring_transactions({ supabase, userId }, input) {
    let query = supabase
      .from("fund_recurring_transactions")
      .select("merchant_name, category, expected_amount, currency, cadence, next_expected_date, last_seen_date, status, source, source_generation_hash")
      .eq("user_id", userId)
      .order("next_expected_date");
    if (input.status) query = query.eq("status", String(input.status));
    const { data, error } = await query;
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    const recurring = data ?? [];
    const detected = recurring.filter((row) => row.source === "detected");
    if (detected.length === 0) {
      return { recurring, authority: "manual", coverage: null };
    }
    const coverage = await readCompleteTransactionCoverage(
      supabase,
      userId,
      new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10),
    );
    if (
      !coverage.available
      || detected.some((row) => !detectedRecurringMatchesCoverage(row, coverage))
    ) throw new ToolExecutionError("DATA_UNAVAILABLE");
    return {
      recurring,
      authority: recurring.some((row) => row.source === "manual") ? "mixed_explicit" : "provider_derived",
      coverage: coverage.facts,
    };
  },

  async get_holdings({ supabase, userId }, input) {
    const { data, error } = await supabase
      .from("fund_holdings")
      .select("symbol, name, shares, cost_basis, source, currency, authority, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state")
      .eq("user_id", userId);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    if (validateAuthoritativeHoldings(data ?? [])) {
      throw new ToolExecutionError("DATA_UNAVAILABLE");
    }
    const coverage = await requireProviderComponentCoverage(
      supabase,
      userId,
      "holdings",
      data ?? [],
    );

    const bySymbol = new Map<string, { symbol: string; name: string; sharesMicro: number; costBasisMinor: number; sources: string[] }>();
    for (const r of data ?? []) {
      if (r.currency !== "USD") throw new ToolExecutionError("DATA_UNAVAILABLE");
      const sharesMicro = strictScaledUnits(r.shares, MICRO_SHARES_PER_SHARE);
      const costBasisMinor = requiredUsdMinor(r.cost_basis);
      if (sharesMicro === null || sharesMicro < 0 || costBasisMinor < 0) throw new ToolExecutionError("DATA_UNAVAILABLE");
      const existing = bySymbol.get(r.symbol);
      if (existing) {
        existing.sharesMicro = safeAdd(existing.sharesMicro, sharesMicro);
        existing.costBasisMinor = safeAdd(existing.costBasisMinor, costBasisMinor);
        if (!existing.sources.includes(r.source)) existing.sources.push(r.source);
      } else {
        bySymbol.set(r.symbol, { symbol: r.symbol, name: r.name, sharesMicro, costBasisMinor, sources: [r.source] });
      }
    }
    const symbolFilter = input.symbol ? String(input.symbol).toUpperCase() : null;
    const aggregated = [...bySymbol.values()]
      .filter((h) => !symbolFilter || h.symbol === symbolFilter)
      .map((h) => ({
        symbol: h.symbol,
        name: h.name,
        shares: scaledUnitsToDecimalString(h.sharesMicro, MICRO_SHARES_PER_SHARE),
        shares_micro: h.sharesMicro,
        cost_basis: minorUnitsToDecimalString(h.costBasisMinor, "USD"),
        cost_basis_minor: h.costBasisMinor,
        sources: h.sources,
        currency: "USD",
      }));
    return { holdings: aggregated, authority: "provider", coverage };
  },

  async get_position({ supabase, userId }, input) {
    const symbol = normalizePositionSymbol(input.symbol);
    if (!symbol) throw new ToolExecutionError("INVALID_INPUT");

    const { data: holdings, error } = await supabase
      .from("fund_holdings")
      .select("symbol, shares, cost_basis, source, currency, authority, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state, generation_id")
      .eq("user_id", userId)
      .eq("symbol", symbol);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const { data: allHoldings, error: allHoldingsError } = await supabase
      .from("fund_holdings")
      .select("symbol, shares, cost_basis, source, currency, authority, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state, generation_id")
      .eq("user_id", userId)
      .limit(MAX_PORTFOLIO_QUOTE_SYMBOLS + 1);
    if (allHoldingsError) throw new ToolExecutionError("DATA_UNAVAILABLE");
    const { data: connections, error: connectionError } = await supabase
      .from("fund_connections")
      .select("id, provider, status, authority, verified_at")
      .eq("user_id", userId)
      .limit(32);
    if (connectionError) throw new ToolExecutionError("DATA_UNAVAILABLE");
    const { data: holdingCoverage, error: holdingCoverageError } = await supabase
      .from("fund_provider_coverage")
      .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason, generation_id, generation_hash")
      .eq("user_id", userId)
      .eq("component", "holdings");
    if (holdingCoverageError) throw new ToolExecutionError("DATA_UNAVAILABLE");

    const sources = [...new Set((holdings ?? []).map((h) => h.source))];

    let quote: PositionQuoteInput = null;
    let quotes = new Map<string, PositionQuoteInput>();
    let quoteCoverageReason = (allHoldings ?? []).length > MAX_PORTFOLIO_QUOTE_SYMBOLS
      ? "PORTFOLIO_QUOTE_LIMIT_EXCEEDED" as const
      : validateAuthoritativeHoldings(allHoldings ?? [])
        ?? validateCurrentConnectionBindings(allHoldings ?? [], connections ?? [])
        ?? validateHoldingCoverage(allHoldings ?? [], connections ?? [], holdingCoverage ?? []);
    if (getPolygonApiKey() && (holdings ?? []).length > 0 && !quoteCoverageReason) {
      const quoteResult = await fetchPortfolioQuotes((allHoldings ?? []).map((holding) => holding.symbol), fetchSnapshot);
      quotes = quoteResult.quotes;
      quoteCoverageReason = quoteResult.reason;
      const targetQuote = quotes.get(symbol);
      quote = quoteIsAuthoritative(targetQuote)
        ? targetQuote
        : null;
    }
    const metrics = calculateLivePosition(symbol, allHoldings ?? [], quotes, Boolean(getPolygonApiKey()), quoteCoverageReason);
    const quoteMinor = quote ? strictMinorUnits(quote.price, "USD") : null;
    const quotePayload = quote && quoteMinor !== null
      ? {
          price: minorUnitsToDecimalString(quoteMinor, "USD"),
          price_minor: quoteMinor,
          change_percent: quote.chg,
          source: quote.source,
          as_of: quote.asOf,
        }
      : null;

    return {
      symbol,
      shares: metrics.sharesMicro === null ? null : scaledUnitsToDecimalString(metrics.sharesMicro, MICRO_SHARES_PER_SHARE),
      shares_micro: metrics.sharesMicro,
      cost_basis: metrics.costBasisMinor === null ? null : minorUnitsToDecimalString(metrics.costBasisMinor, "USD"),
      cost_basis_minor: metrics.costBasisMinor,
      sources,
      quote: quotePayload,
      quote_available: quotePayload !== null,
      live_available: metrics.available,
      live_reason: metrics.reason,
      position_value: metrics.positionValueMinor === null ? null : minorUnitsToDecimalString(metrics.positionValueMinor, "USD"),
      position_value_minor: metrics.positionValueMinor,
      unrealized_pl: metrics.unrealizedPLMinor === null ? null : minorUnitsToDecimalString(metrics.unrealizedPLMinor, "USD"),
      unrealized_pl_minor: metrics.unrealizedPLMinor,
      weight: metrics.weight,
    };
  },

  async get_liabilities({ supabase, userId }) {
    const { data, error } = await supabase
      .from("fund_liabilities")
      .select("name, kind, balance, apr, minimum_payment, due_date, source, currency, authority, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state")
      .eq("user_id", userId);
    if (error) throw new ToolExecutionError("DATA_UNAVAILABLE");
    const rows = data ?? [];
    if (rows.some((row) =>
      row.authority !== "provider"
      || row.source !== "plaid"
      || row.provider !== "plaid"
      || typeof row.provider_record_id !== "string"
      || !row.provider_record_id
      || typeof row.connection_id !== "string"
      || classifyFreshness(row.retrieved_at, FRESHNESS_SLAS.accountBalance) !== "fresh"
      || row.reconciliation_state !== "matched"
      || row.currency !== "USD"
    )) throw new ToolExecutionError("DATA_UNAVAILABLE");
    const coverage = await requireProviderComponentCoverage(
      supabase,
      userId,
      "liabilities",
      rows,
    );
    return { liabilities: rows, authority: "provider", coverage };
  },

  async get_cash_accounts({ supabase, userId }) {
    void supabase;
    void userId;
    // The advisor executes with the owner's RLS client, which intentionally
    // cannot select encrypted access tokens. A future server-only adapter can
    // expose normalized balances; until then, do not weaken token grants.
    return {
      accounts: [],
      total_cash: null,
      available: false,
      reason: "CASH_PROVIDER_SERVER_ADAPTER_REQUIRED",
    };
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

  async compute_safe_to_invest() {
    // Recurring charges and budget rows do not yet carry complete provider
    // provenance/currency coverage. Do not turn live cash into an affordability
    // recommendation by blending those unproven values.
    return { available: false, reason: "RECURRING_COVERAGE_UNAVAILABLE", cash_on_hand: null, upcoming_bills_next_14_days: null, buffer: null, safe_to_invest: null, bills_counted: [] };
  },
};

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) throw new ToolExecutionError("INVALID_INPUT");
  return handler(ctx, input);
}
