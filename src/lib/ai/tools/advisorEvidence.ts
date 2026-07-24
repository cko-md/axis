import { z } from "zod";

export type AdvisorEvidence = {
  source: string;
  title: string;
  facts: string[];
};

export type AdvisorEvidenceResult =
  | { ok: true; evidence: AdvisorEvidence }
  | {
      ok: false;
      code:
        | "EVIDENCE_INVALID"
        | "EVIDENCE_EMPTY"
        | "EVIDENCE_UNAVAILABLE"
        | "EVIDENCE_UNSUPPORTED";
    };

const boundedString = z.string().trim().min(1).max(240);
const optionalString = z.string().trim().max(240).nullable().optional();
const dateString = z.string().trim().min(1).max(64);
const finiteNumber = z
  .union([
    z.number(),
    z.string().trim().max(64).regex(/^-?\d+(?:\.\d+)?$/),
  ])
  .transform(Number)
  .pipe(z.number().finite().min(-1_000_000_000_000_000).max(1_000_000_000_000_000));

const sourceList = z.array(boundedString).max(20);
const quoteSchema = z.object({
  price: finiteNumber,
  chg: finiteNumber,
  open: finiteNumber.optional(),
  vol: finiteNumber.optional(),
  source: z.literal("live").optional(),
  ts: finiteNumber.optional(),
}).strict();

const schemas = {
  get_net_worth_history: z.object({
    snapshots: z.array(z.object({
      captured_on: dateString,
      cash: finiteNumber,
      invested: finiteNumber,
      liabilities: finiteNumber,
      net_worth: finiteNumber,
    }).strict()).max(100),
  }).strict(),
  get_spending_by_category: z.object({
    range_days: finiteNumber,
    since: dateString,
    by_category: z.array(z.object({
      category: boundedString,
      total: finiteNumber,
    }).strict()).max(100),
  }).strict(),
  get_budget_status: z.object({
    month_to_date_since: dateString,
    budgets: z.array(z.object({
      category: boundedString,
      monthly_limit: finiteNumber,
      spent_so_far: finiteNumber,
    }).strict()).max(100),
  }).strict(),
  get_recurring_transactions: z.object({
    recurring: z.array(z.object({
      merchant_name: boundedString,
      category: optionalString,
      expected_amount: finiteNumber,
      cadence: boundedString,
      next_expected_date: optionalString,
      last_seen_date: optionalString,
      status: boundedString,
      source: boundedString,
    }).strict()).max(100),
  }).strict(),
  get_holdings: z.object({
    holdings: z.array(z.object({
      symbol: boundedString,
      name: boundedString,
      shares: finiteNumber,
      cost_basis: finiteNumber,
      sources: sourceList,
    }).strict()).max(100),
  }).strict(),
  get_position: z.object({
    symbol: boundedString,
    shares: finiteNumber,
    cost_basis: finiteNumber,
    sources: sourceList,
    quote: quoteSchema.nullable(),
    quote_available: z.boolean(),
    unrealized_pl: finiteNumber,
    weight: finiteNumber,
  }).strict(),
  get_liabilities: z.object({
    liabilities: z.array(z.object({
      name: boundedString,
      kind: boundedString,
      balance: finiteNumber,
      apr: finiteNumber.nullable().optional(),
      minimum_payment: finiteNumber.nullable().optional(),
      due_date: optionalString,
      source: boundedString,
    }).strict()).max(100),
  }).strict(),
  get_cash_accounts: z.object({
    accounts: z.array(z.object({
      connection_id: boundedString,
      item_id: boundedString,
      provider_account_id: boundedString,
      persistent_account_id: optionalString,
      name: boundedString,
      mask: optionalString,
      type: z.literal("depository"),
      subtype: boundedString,
      balance: finiteNumber,
      balance_basis: z.literal("available"),
      currency: z.literal("USD"),
      source: z.literal("plaid_live"),
      retrieved_at: dateString,
    }).strict()).max(100),
    total_cash: finiteNumber,
    currency: z.literal("USD"),
    source: z.literal("plaid_live"),
    retrieved_at: dateString,
    coverage: z.object({
      connections_expected: z.literal(1),
      connections_succeeded: z.literal(1),
      complete: z.literal(true),
    }).strict(),
  }).strict(),
  get_market_quote: z.discriminatedUnion("available", [
    z.object({
      symbol: boundedString,
      available: z.literal(false),
      reason: boundedString,
    }).strict(),
    z.object({
      symbol: boundedString,
      available: z.literal(true),
      price: finiteNumber,
      chg: finiteNumber,
      open: finiteNumber.optional(),
      vol: finiteNumber.optional(),
      source: z.literal("live"),
      ts: finiteNumber.optional(),
    }).strict(),
  ]),
  get_market_news: z.discriminatedUnion("available", [
    z.object({
      news: z.array(z.never()).max(0),
      available: z.literal(false),
      reason: boundedString,
    }).strict(),
    z.object({
      news: z.array(z.object({
        title: boundedString,
        url: z.string().url().max(2_048),
        publisher: z.string().trim().max(240),
        tickers: z.array(boundedString).max(20),
        publishedAt: dateString,
      }).strict()).max(50),
      available: z.literal(true),
    }).strict(),
  ]),
  get_watchlist: z.object({
    watchlist: z.array(z.object({
      symbol: boundedString,
      name: boundedString,
    }).strict()).max(100),
  }).strict(),
  search_tickers: z.discriminatedUnion("available", [
    z.object({
      hits: z.array(z.never()).max(0),
      available: z.literal(false),
      reason: boundedString,
    }).strict(),
    z.object({
      hits: z.array(z.object({
        sym: boundedString,
        name: boundedString,
        ex: z.string().trim().max(100),
      }).strict()).max(50),
      available: z.literal(true),
    }).strict(),
  ]),
  compute_safe_to_invest: z.object({
    cash_on_hand: finiteNumber,
    upcoming_bills_next_14_days: finiteNumber,
    buffer: finiteNumber,
    safe_to_invest: finiteNumber,
    bills_counted: z.array(z.object({
      merchant_name: boundedString,
      expected_amount: finiteNumber,
      next_expected_date: dateString,
    }).strict()).max(100),
  }).strict(),
} as const;

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function number(value: number, maximumFractionDigits = 6) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function percent(value: number) {
  return `${number(value, 2)}%`;
}

function limited<T>(items: T[], limit = 10) {
  return {
    shown: items.slice(0, limit),
    remainder: Math.max(0, items.length - limit),
  };
}

function withRemainder(facts: string[], remainder: number) {
  return remainder > 0 ? [...facts, `Plus ${remainder} more verified row${remainder === 1 ? "" : "s"}.`] : facts;
}

function success(source: string, title: string, facts: string[]): AdvisorEvidenceResult {
  if (facts.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
  return { ok: true, evidence: { source, title, facts } };
}

export function renderAdvisorEvidence(
  source: string,
  output: unknown,
): AdvisorEvidenceResult {
  switch (source) {
    case "get_net_worth_history": {
      const parsed = schemas.get_net_worth_history.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      const latest = parsed.data.snapshots[0];
      if (!latest) return { ok: false, code: "EVIDENCE_EMPTY" };
      return success(source, "Net worth", [
        `As of ${latest.captured_on}: net worth ${money(latest.net_worth)}, cash ${money(latest.cash)}, invested ${money(latest.invested)}, liabilities ${money(latest.liabilities)}.`,
        `Verified history contains ${parsed.data.snapshots.length} snapshot${parsed.data.snapshots.length === 1 ? "" : "s"}.`,
      ]);
    }
    case "get_spending_by_category": {
      const parsed = schemas.get_spending_by_category.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.by_category.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const rows = [...parsed.data.by_category].sort((a, b) =>
        b.total - a.total || a.category.localeCompare(b.category));
      const { shown, remainder } = limited(rows);
      return success(source, "Spending by category", withRemainder([
        `Verified range: ${number(parsed.data.range_days, 0)} days since ${parsed.data.since}.`,
        ...shown.map((row) => `${row.category}: ${money(row.total)} spent.`),
      ], remainder));
    }
    case "get_budget_status": {
      const parsed = schemas.get_budget_status.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.budgets.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const rows = [...parsed.data.budgets].sort((a, b) =>
        a.category.localeCompare(b.category));
      const { shown, remainder } = limited(rows);
      return success(source, "Budget status", withRemainder([
        `Month-to-date since ${parsed.data.month_to_date_since}.`,
        ...shown.map((row) =>
          `${row.category}: ${money(row.spent_so_far)} spent of ${money(row.monthly_limit)} (${money(row.monthly_limit - row.spent_so_far)} remaining).`),
      ], remainder));
    }
    case "get_recurring_transactions": {
      const parsed = schemas.get_recurring_transactions.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.recurring.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const { shown, remainder } = limited(parsed.data.recurring);
      return success(source, "Recurring transactions", withRemainder(
        shown.map((row) =>
          `${row.merchant_name}: ${money(row.expected_amount)} ${row.cadence}, status ${row.status}${row.next_expected_date ? `, next expected ${row.next_expected_date}` : ""}.`),
        remainder,
      ));
    }
    case "get_holdings": {
      const parsed = schemas.get_holdings.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.holdings.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const rows = [...parsed.data.holdings].sort((a, b) => a.symbol.localeCompare(b.symbol));
      const { shown, remainder } = limited(rows);
      return success(source, "Holdings", withRemainder(
        shown.map((row) =>
          `${row.symbol} (${row.name}): ${number(row.shares)} shares, ${money(row.cost_basis)} cost basis, sources ${row.sources.join(", ") || "none"}.`),
        remainder,
      ));
    }
    case "get_position": {
      const parsed = schemas.get_position.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.shares <= 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const facts = [
        `${parsed.data.symbol}: ${number(parsed.data.shares)} shares with ${money(parsed.data.cost_basis)} cost basis.`,
        `Unrealized P/L ${money(parsed.data.unrealized_pl)}; portfolio weight ${percent(parsed.data.weight * 100)}.`,
      ];
      if (parsed.data.quote_available && parsed.data.quote) {
        facts.push(`Live quote ${money(parsed.data.quote.price)}; day change ${percent(parsed.data.quote.chg)}.`);
      } else {
        facts.push("Live quote unavailable; valuation may use cost basis.");
      }
      return success(source, "Position", facts);
    }
    case "get_liabilities": {
      const parsed = schemas.get_liabilities.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.liabilities.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const rows = [...parsed.data.liabilities].sort((a, b) => a.name.localeCompare(b.name));
      const { shown, remainder } = limited(rows);
      return success(source, "Liabilities", withRemainder(
        shown.map((row) =>
          `${row.name} (${row.kind}): balance ${money(row.balance)}${row.apr != null ? `, APR ${percent(row.apr)}` : ""}${row.minimum_payment != null ? `, minimum ${money(row.minimum_payment)}` : ""}${row.due_date ? `, due ${row.due_date}` : ""}.`),
        remainder,
      ));
    }
    case "get_cash_accounts": {
      const parsed = schemas.get_cash_accounts.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.accounts.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const accountTotal = parsed.data.accounts.reduce(
        (total, account) => total + account.balance,
        0,
      );
      if (Math.abs(accountTotal - parsed.data.total_cash) > 0.01) {
        return { ok: false, code: "EVIDENCE_INVALID" };
      }
      if (
        parsed.data.coverage.connections_expected
        !== parsed.data.coverage.connections_succeeded
        || new Set(
          parsed.data.accounts.map((account) => account.connection_id),
        ).size !== 1
        || new Set(
          parsed.data.accounts.map((account) => account.item_id),
        ).size !== 1
        || new Set(
          parsed.data.accounts.map(
            (account) =>
              `${account.item_id}:${account.provider_account_id}`,
          ),
        ).size !== parsed.data.accounts.length
        || parsed.data.accounts.some(
          (account) => account.retrieved_at !== parsed.data.retrieved_at,
        )
      ) {
        return { ok: false, code: "EVIDENCE_INVALID" };
      }
      const rows = [...parsed.data.accounts].sort((a, b) => a.name.localeCompare(b.name));
      const { shown, remainder } = limited(rows);
      return success(source, "Cash accounts", withRemainder([
        `Verified USD total cash: ${money(parsed.data.total_cash)} from one unambiguous live Plaid Item, retrieved ${parsed.data.retrieved_at}.`,
        ...shown.map((row) =>
          `${row.name}${row.mask ? ` ending ${row.mask}` : ""} (${row.subtype}): ${money(row.balance)} available USD via Plaid live balance.`),
      ], remainder));
    }
    case "get_market_quote": {
      const parsed = schemas.get_market_quote.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (!parsed.data.available) return { ok: false, code: "EVIDENCE_UNAVAILABLE" };
      return success(source, "Market quote", [
        `${parsed.data.symbol}: live price ${money(parsed.data.price)}, day change ${percent(parsed.data.chg)}${parsed.data.ts ? `, provider timestamp ${number(parsed.data.ts, 0)}` : ""}.`,
      ]);
    }
    case "get_market_news": {
      const parsed = schemas.get_market_news.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (!parsed.data.available) return { ok: false, code: "EVIDENCE_UNAVAILABLE" };
      if (parsed.data.news.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const { shown, remainder } = limited(parsed.data.news);
      return success(source, "Market news", withRemainder(
        shown.map((row) =>
          `${row.publishedAt}: ${row.title}${row.publisher ? ` — ${row.publisher}` : ""}${row.tickers.length ? ` (${row.tickers.join(", ")})` : ""}.`),
        remainder,
      ));
    }
    case "get_watchlist": {
      const parsed = schemas.get_watchlist.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (parsed.data.watchlist.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const { shown, remainder } = limited(parsed.data.watchlist);
      return success(source, "Watchlist", withRemainder(
        shown.map((row) => `${row.symbol}: ${row.name}.`),
        remainder,
      ));
    }
    case "search_tickers": {
      const parsed = schemas.search_tickers.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      if (!parsed.data.available) return { ok: false, code: "EVIDENCE_UNAVAILABLE" };
      if (parsed.data.hits.length === 0) return { ok: false, code: "EVIDENCE_EMPTY" };
      const { shown, remainder } = limited(parsed.data.hits);
      return success(source, "Ticker search", withRemainder(
        shown.map((row) => `${row.sym}: ${row.name}${row.ex ? ` (${row.ex})` : ""}.`),
        remainder,
      ));
    }
    case "compute_safe_to_invest": {
      const parsed = schemas.compute_safe_to_invest.safeParse(output);
      if (!parsed.success) return { ok: false, code: "EVIDENCE_INVALID" };
      const recomputed =
        parsed.data.cash_on_hand
        - parsed.data.upcoming_bills_next_14_days
        - parsed.data.buffer;
      if (Math.abs(recomputed - parsed.data.safe_to_invest) > 0.01) {
        return { ok: false, code: "EVIDENCE_INVALID" };
      }
      return success(source, "Safe-to-invest calculation", [
        `Cash on hand ${money(parsed.data.cash_on_hand)} minus upcoming 14-day bills ${money(parsed.data.upcoming_bills_next_14_days)} and buffer ${money(parsed.data.buffer)} equals ${money(parsed.data.safe_to_invest)} safe to invest.`,
        `${parsed.data.bills_counted.length} upcoming bill${parsed.data.bills_counted.length === 1 ? "" : "s"} counted.`,
      ]);
    }
    default:
      return { ok: false, code: "EVIDENCE_UNSUPPORTED" };
  }
}

export function combineAdvisorEvidence(
  evidence: readonly AdvisorEvidence[],
): string | null {
  if (evidence.length === 0) return null;
  const text = evidence
    .map((item) => `${item.title}\n${item.facts.map((fact) => `• ${fact}`).join("\n")}`)
    .join("\n\n");
  return text.length <= 12_000 ? text : null;
}
