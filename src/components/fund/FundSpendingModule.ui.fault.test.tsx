// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUBJECT = `ps1_${"a".repeat(64)}`;
vi.mock("@/components/layout/ShellProfileContext", () => ({
  useShellProfile: () => ({ state: "ready", profile: { subject: SUBJECT }, authorityEpoch: 1 }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ui/Card", () => ({ Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
vi.mock("@/components/ui/Modal", () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/Button", () => ({ Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock("@/components/ui/FreshnessBadge", () => ({ FreshnessBadge: () => null }));

import { FundSpendingModule } from "./FundSpendingModule";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function transaction(id: string) {
  return {
    id,
    merchant_name: `Merchant ${id}`,
    raw_name: `Merchant ${id}`,
    amount: -10,
    amount_minor: -1_000,
    iso_currency_code: "USD",
    plaid_category: "FOOD_AND_DRINK",
    custom_category: null,
    tags: null,
    is_transfer: false,
    excluded_from_budget: false,
    reviewed: false,
    pending: false,
    posted_date: "2026-08-01",
  };
}

async function settle() {
  for (let index = 0; index < 6; index++) {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
}

describe("spending complete-generation pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("rejects a lineage change between pages and shows no mixed totals", async () => {
    let transactionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("bank-transactions")) {
        transactionCalls += 1;
        return transactionCalls === 1
          ? json({ transactions: [transaction("A")], completeness: "complete_source_page", lineageHash: "a".repeat(64), page: { hasMore: true } })
          : json({ transactions: [transaction("B")], completeness: "complete_source_page", lineageHash: "b".repeat(64), page: { hasMore: false } });
      }
      if (url.endsWith("/api/fund/category-budgets")) return json({ budgets: [] });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root?.render(<FundSpendingModule />); });
    await settle();

    expect(container.textContent).toContain("Complete transaction history is unavailable; no totals are shown.");
    expect(container.textContent).not.toContain("Merchant A");
    expect(container.textContent).not.toContain("Merchant B");
    for (const [input, init] of fetchMock.mock.calls) {
      if (!String(input).includes("/api/fund/")) continue;
      expect(new Headers(init?.headers).get("x-axis-expected-profile-subject")).toBe(SUBJECT);
    }
  });
});
