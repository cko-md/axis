import { describe, expect, it } from "vitest";
import {
  combineAdvisorEvidence,
  renderAdvisorEvidence,
  type AdvisorEvidence,
} from "./advisorEvidence";

const formatterCases: Array<{
  source: string;
  output: unknown;
  title: string;
  fact: string;
}> = [
  {
    source: "get_net_worth_history",
    output: {
      snapshots: [{
        captured_on: "2026-07-23",
        cash: 1_000,
        invested: 2_500,
        liabilities: 500,
        net_worth: 3_000,
      }],
    },
    title: "Net worth",
    fact: "$3,000.00",
  },
  {
    source: "get_spending_by_category",
    output: {
      range_days: 30,
      since: "2026-06-23",
      by_category: [{ category: "Travel", total: 412.5 }],
    },
    title: "Spending by category",
    fact: "Travel: $412.50",
  },
  {
    source: "get_budget_status",
    output: {
      month_to_date_since: "2026-07-01",
      budgets: [{
        category: "Dining",
        monthly_limit: 500,
        spent_so_far: 125,
      }],
    },
    title: "Budget status",
    fact: "$375.00 remaining",
  },
  {
    source: "get_recurring_transactions",
    output: {
      recurring: [{
        merchant_name: "Axis Mobile",
        category: "Utilities",
        expected_amount: 75,
        cadence: "monthly",
        next_expected_date: "2026-08-01",
        last_seen_date: "2026-07-01",
        status: "active",
        source: "manual",
      }],
    },
    title: "Recurring transactions",
    fact: "$75.00 monthly",
  },
  {
    source: "get_holdings",
    output: {
      holdings: [{
        symbol: "AXIS",
        name: "Axis Industries",
        shares: 2.5,
        cost_basis: 300,
        sources: ["manual"],
      }],
    },
    title: "Holdings",
    fact: "2.5 shares",
  },
  {
    source: "get_position",
    output: {
      symbol: "AXIS",
      shares: 2,
      cost_basis: 200,
      sources: ["manual"],
      quote: {
        price: 125,
        chg: 1.25,
        source: "live",
      },
      quote_available: true,
      unrealized_pl: 50,
      weight: 0.25,
    },
    title: "Position",
    fact: "portfolio weight 25%",
  },
  {
    source: "get_liabilities",
    output: {
      liabilities: [{
        name: "Student loan",
        kind: "loan",
        balance: 9_500,
        apr: 4.5,
        minimum_payment: 150,
        due_date: "2026-08-10",
        source: "manual",
      }],
    },
    title: "Liabilities",
    fact: "APR 4.5%",
  },
  {
    source: "get_cash_accounts",
    output: {
      accounts: [
        {
          connection_id: "connection-1",
          item_id: "item-1",
          provider_account_id: "provider-account-1",
          persistent_account_id: "persistent-account-1",
          name: "Checking",
          mask: "1234",
          type: "depository",
          subtype: "checking",
          balance: 800,
          balance_basis: "available",
          currency: "USD",
          source: "plaid_live",
          retrieved_at: "2026-07-23T12:00:00Z",
        },
        {
          connection_id: "connection-1",
          item_id: "item-1",
          provider_account_id: "provider-account-2",
          persistent_account_id: "persistent-account-2",
          name: "Savings",
          mask: "5678",
          type: "depository",
          subtype: "savings",
          balance: 1_200,
          balance_basis: "available",
          currency: "USD",
          source: "plaid_live",
          retrieved_at: "2026-07-23T12:00:00Z",
        },
      ],
      total_cash: 2_000,
      currency: "USD",
      source: "plaid_live",
      retrieved_at: "2026-07-23T12:00:00Z",
      coverage: {
        connections_expected: 1,
        connections_succeeded: 1,
        complete: true,
      },
    },
    title: "Cash accounts",
    fact: "Verified USD total cash: $2,000.00",
  },
  {
    source: "get_market_quote",
    output: {
      symbol: "AXIS",
      available: true,
      price: 125.5,
      chg: -0.5,
      source: "live",
      ts: 1_753_248_000_000,
    },
    title: "Market quote",
    fact: "live price $125.50",
  },
  {
    source: "get_market_news",
    output: {
      news: [{
        title: "Axis posts verified results",
        url: "https://example.com/axis",
        publisher: "Example",
        tickers: ["AXIS"],
        publishedAt: "2026-07-23T12:00:00Z",
      }],
      available: true,
    },
    title: "Market news",
    fact: "Axis posts verified results",
  },
  {
    source: "get_watchlist",
    output: {
      watchlist: [{ symbol: "AXIS", name: "Axis Industries" }],
    },
    title: "Watchlist",
    fact: "AXIS: Axis Industries",
  },
  {
    source: "search_tickers",
    output: {
      hits: [{ sym: "AXIS", name: "Axis Industries", ex: "XNYS" }],
      available: true,
    },
    title: "Ticker search",
    fact: "AXIS: Axis Industries (XNYS)",
  },
  {
    source: "compute_safe_to_invest",
    output: {
      cash_on_hand: 1_000,
      upcoming_bills_next_14_days: 250,
      buffer: 100,
      safe_to_invest: 650,
      bills_counted: [{
        merchant_name: "Rent",
        expected_amount: 250,
        next_expected_date: "2026-08-01",
      }],
    },
    title: "Safe-to-invest calculation",
    fact: "equals $650.00 safe to invest",
  },
];

describe("Advisor deterministic evidence renderers", () => {
  it.each(formatterCases)(
    "renders verified $source output",
    ({ source, output, title, fact }) => {
      const result = renderAdvisorEvidence(source, output);
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        evidence: expect.objectContaining({ source, title }),
      }));
      if (result.ok) expect(result.evidence.facts.join(" ")).toContain(fact);
    },
  );

  it("combines multiple tool outputs without model-authored prose", () => {
    const evidence: AdvisorEvidence[] = formatterCases
      .slice(0, 2)
      .map(({ source, output }) => {
        const result = renderAdvisorEvidence(source, output);
        if (!result.ok) throw new Error(result.code);
        return result.evidence;
      });

    const combined = combineAdvisorEvidence(evidence);

    expect(combined).toContain("Net worth");
    expect(combined).toContain("$3,000.00");
    expect(combined).toContain("Spending by category");
    expect(combined).toContain("Travel: $412.50");
  });

  it.each([
    ["unavailable", "get_market_quote", {
      symbol: "AXIS",
      available: false,
      reason: "QUOTE_UNAVAILABLE",
    }, "EVIDENCE_UNAVAILABLE"],
    ["provider error", "get_holdings", {
      error: "TOOL_EXECUTION_FAILED",
    }, "EVIDENCE_INVALID"],
    ["empty result", "get_holdings", {
      holdings: [],
    }, "EVIDENCE_EMPTY"],
    ["oversized field", "get_holdings", {
      holdings: [{
        symbol: "AXIS",
        name: "x".repeat(241),
        shares: 1,
        cost_basis: 1,
        sources: ["manual"],
      }],
    }, "EVIDENCE_INVALID"],
    ["unsupported tool", "write_trade", {
      ok: true,
    }, "EVIDENCE_UNSUPPORTED"],
  ])("contains %s output", (_case, source, output, code) => {
    expect(renderAdvisorEvidence(source, output)).toEqual({ ok: false, code });
  });

  it("rejects inconsistent financial arithmetic", () => {
    expect(renderAdvisorEvidence("compute_safe_to_invest", {
      cash_on_hand: 1_000,
      upcoming_bills_next_14_days: 250,
      buffer: 100,
      safe_to_invest: 999,
      bills_counted: [],
    })).toEqual({ ok: false, code: "EVIDENCE_INVALID" });
    expect(renderAdvisorEvidence("get_cash_accounts", {
      accounts: [{
        connection_id: "connection-1",
        item_id: "item-1",
        provider_account_id: "provider-account-1",
        persistent_account_id: "persistent-account-1",
        name: "Checking",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        balance: 800,
        balance_basis: "available",
        currency: "USD",
        source: "plaid_live",
        retrieved_at: "2026-07-23T12:00:00Z",
      }],
      total_cash: 900,
      currency: "USD",
      source: "plaid_live",
      retrieved_at: "2026-07-23T12:00:00Z",
      coverage: {
        connections_expected: 1,
        connections_succeeded: 1,
        complete: true,
      },
    })).toEqual({ ok: false, code: "EVIDENCE_INVALID" });
  });

  it("fails closed when combined evidence exceeds its response bound", () => {
    expect(combineAdvisorEvidence([{
      source: "get_holdings",
      title: "Holdings",
      facts: ["x".repeat(12_001)],
    }])).toBeNull();
  });
});
