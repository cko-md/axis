// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plaid: vi.fn(),
  fundData: vi.fn(),
}));

vi.mock("@/lib/fund/usePlaidConnection", () => ({
  usePlaidConnection: mocks.plaid,
}));
vi.mock("@/components/fund/FundDataProvider", () => ({
  useFundData: mocks.fundData,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  }),
}));
vi.mock("@/components/ui/Card", () => ({
  Card: ({ children }: { children: ReactNode }) => <section data-card>{children}</section>,
}));
vi.mock("@/components/fund/NetWorthChart", () => ({
  NetWorthChart: () => <div data-net-worth-chart />,
}));
vi.mock("@/components/fund/FundSparkline", () => ({
  FundSparkline: () => <div data-sparkline />,
}));
vi.mock("@/components/ui/FreshnessBadge", () => ({
  FreshnessBadge: () => <span data-freshness />,
}));

import { FundNetWorthModule } from "./FundNetWorthModule";
import { FundPositionPage } from "./FundPositionPage";
import { OverviewModule } from "./OverviewModule";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function defaultPlaid() {
  return {
    plaidConfigured: true,
    plaidLinked: true,
    brokerageConfigured: false,
    bankAccounts: [],
    balanceError: false,
    cash: null,
    cashReason: "PLAID_BALANCES_FAILED",
    connectBank: vi.fn(),
    linking: false,
    reloadBalances: vi.fn(),
  };
}

function defaultFundData() {
  return {
    liabilities: [],
    plaidLiabilities: [],
    aggregated: [],
    signedIn: true,
  };
}

function parsedStatic(element: ReactNode) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderToStaticMarkup(element);
  return wrapper;
}

async function renderClient(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  return container;
}

describe("signed-in financial truth UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    mocks.plaid.mockReturnValue(defaultPlaid());
    mocks.fundData.mockReturnValue(defaultFundData());
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("withholds Overview net worth and visibly labels basis when live values are unavailable", () => {
    const view = parsedStatic(<OverviewModule />);
    const text = view.textContent ?? "";

    expect(text).toContain("Net Worth—");
    expect(text).toContain("Live net worth requires complete provider coverage");
    expect(text).toContain("Invested cost basis");
    expect(text).toContain("Cash—");
    expect(text).toContain("Cash unavailable: PLAID_BALANCES_FAILED");
    expect(text).toContain("Cost basis · live movers unavailable");
    expect(text).not.toContain("Top Movers");
  });

  it("renders a missing provider liability as unavailable instead of numeric zero", () => {
    mocks.fundData.mockReturnValue({
      ...defaultFundData(),
      plaidLiabilities: [{
        accountId: "liability-1",
        name: "Card",
        type: "credit",
        balanceCurrent: null,
        retrievedAt: null,
      }],
    });
    const view = parsedStatic(<FundNetWorthModule />);
    const liabilityHeading = [...view.querySelectorAll("h2")]
      .find((heading) => heading.textContent?.startsWith("Liabilities"));
    const liabilityCard = liabilityHeading?.closest("[data-card]");

    expect(liabilityHeading?.textContent).toContain("Provider/manual totals not combined");
    expect(liabilityCard?.textContent).toContain("Card · Plaid—");
    expect(liabilityCard?.textContent).not.toContain("$0");
  });

  it("labels unavailable position value, P/L, and weight instead of rendering cost basis as live", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      symbol: "AAPL",
      shares: "2.000000",
      sharesMicro: 2_000_000,
      costBasis: "100.00",
      costBasisMinor: 10_000,
      sources: ["plaid"],
      quote: null,
      news: [],
      liveAvailable: false,
      liveReason: "QUOTE_UNAVAILABLE",
      positionValue: null,
      unrealizedPL: null,
      weight: null,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const view = await renderClient(<FundPositionPage symbol="AAPL" />);
    const cards = [...view.querySelectorAll("[data-card]")];

    expect(cards[0]?.textContent).toContain("Position value—");
    expect(cards[0]?.textContent).not.toContain("$100");
    expect(cards[1]?.textContent).toContain("Cost basis$100");
    expect(cards[2]?.textContent).toContain("Unrealized P/L—");
    expect(cards[3]?.textContent).toContain("Portfolio weight—");
    expect(view.textContent).toContain("Live position metrics unavailable: QUOTE_UNAVAILABLE");
  });
});
