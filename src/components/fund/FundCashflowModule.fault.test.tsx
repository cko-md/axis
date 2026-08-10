// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;
let shell = { state: "ready", profile: { subject: SUBJECT_A }, authorityEpoch: 1 };

vi.mock("@/components/layout/ShellProfileContext", () => ({ useShellProfile: () => shell }));
vi.mock("@/lib/fund/usePlaidConnection", () => ({
  usePlaidConnection: () => ({
    plaidConfigured: true,
    plaidLinked: true,
    plaidReconnectRequired: false,
    plaidStatusState: "ready",
    cashMinor: 10_000,
    connectBank: vi.fn(),
    recoverBankConnection: vi.fn(),
    balanceError: false,
  }),
}));
vi.mock("@/components/ui/Card", () => ({ Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
vi.mock("@/components/fund/FundBudget", () => ({ FundBudget: () => null }));
vi.mock("@/components/fund/FundLiabilities", () => ({ FundLiabilities: () => null }));
vi.mock("@/components/fund/FundRecurringList", () => ({ FundRecurringList: () => null }));

import { FundCashflowModule } from "./FundCashflowModule";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function txn(amount: string) {
  return {
    amount,
    is_transfer: false,
    posted_date: "2026-08-09",
    iso_currency_code: "USD",
    connection_id: "connection-1",
    retrieved_at: "2026-08-09T12:00:00.000Z",
  };
}

function transactionBody(amounts: string[], hash = "a".repeat(64), hasMore = false) {
  return {
    transactions: amounts.map(txn),
    completeness: "complete_source_page",
    lineageHash: hash,
    page: { hasMore },
  };
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

async function render() {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root?.render(<FundCashflowModule />); });
}

async function flush() {
  for (let index = 0; index < 5; index++) {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
}

describe("cash-flow subject and generation containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    shell = { state: "ready", profile: { subject: SUBJECT_A }, authorityEpoch: 1 };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("does not let a delayed subject A body overwrite subject B cash flow", async () => {
    let resolveA: ((body: unknown) => void) | null = null;
    const delayedA = new Promise((resolve) => { resolveA = resolve; });
    let transactionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("bank-transactions")) {
        transactionCalls += 1;
        if (transactionCalls === 1) return { ok: true, json: () => delayedA };
        return json(transactionBody(["100.00", "-40.00"]));
      }
      return json({ recurring: [] });
    }));

    await render();
    shell = { state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 };
    await render();
    await flush();
    expect(container?.textContent).toContain("$100.00");
    expect(container?.textContent).toContain("$40.00");

    await act(async () => { resolveA?.(transactionBody(["999.00", "-888.00"])); await Promise.resolve(); });
    expect(container?.textContent).toContain("$100.00");
    expect(container?.textContent).not.toContain("$999.00");
  });

  it("masks subject A totals on the first subject B render before effects settle", async () => {
    let transactionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("bank-transactions")) return json({ recurring: [] });
      transactionCalls += 1;
      if (transactionCalls === 1) return json(transactionBody(["333.00", "-33.00"]));
      return { ok: true, json: () => new Promise(() => undefined) };
    }));
    await render();
    await flush();
    expect(container?.textContent).toContain("$333.00");

    shell = { state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 };
    flushSync(() => { root?.render(<FundCashflowModule />); });

    expect(container?.textContent).not.toContain("$333.00");
    expect(container?.textContent).toContain("Income · 30d—");
  });

  it("uses request generation as well as subject across A to B to A", async () => {
    let resolveOldA: ((body: unknown) => void) | null = null;
    let transactionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("bank-transactions")) return json({ recurring: [] });
      transactionCalls += 1;
      if (transactionCalls === 1) return { ok: true, json: () => new Promise((resolve) => { resolveOldA = resolve; }) };
      if (transactionCalls === 2) return json(transactionBody(["200.00", "-20.00"]));
      return json(transactionBody(["111.00", "-11.00"]));
    }));

    await render();
    shell = { state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 };
    await render();
    await flush();
    shell = { state: "ready", profile: { subject: SUBJECT_A }, authorityEpoch: 3 };
    await render();
    await flush();
    expect(container?.textContent).toContain("$111.00");

    await act(async () => { resolveOldA?.(transactionBody(["999.00", "-99.00"])); await Promise.resolve(); });
    expect(container?.textContent).toContain("$111.00");
    expect(container?.textContent).not.toContain("$999.00");
  });

  it("withholds totals when pagination lineage changes mid-read", async () => {
    let transactionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("bank-transactions")) return json({ recurring: [] });
      transactionCalls += 1;
      return transactionCalls === 1
        ? json(transactionBody(["100.00"], "a".repeat(64), true))
        : json(transactionBody(["-40.00"], "b".repeat(64), false));
    }));

    await render();
    await flush();

    expect(container?.textContent).toContain("Income · 30d—");
    expect(container?.textContent).toContain("Spend · 30d—");
    expect(container?.textContent).toContain("transactions unavailable");
  });
});
