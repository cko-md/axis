// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shellProfile: vi.fn() }));

vi.mock("@/components/layout/ShellProfileContext", () => ({
  useShellProfile: mocks.shellProfile,
}));

import { FundBudget } from "./FundBudget";
import { FundTransactions } from "./FundTransactions";

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle() {
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("legacy Fund card subject boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT_A },
      authorityEpoch: 1,
    });
    vi.stubGlobal("React", React);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("ignores delayed A bodies, renders only B data, and binds both requests to authority", async () => {
    let resolveABudget: ((value: unknown) => void) | null = null;
    let resolveATransactions: ((value: unknown) => void) | null = null;
    const delayedABudget = new Promise((resolve) => { resolveABudget = resolve; });
    const delayedATransactions = new Promise((resolve) => { resolveATransactions = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const subject = new Headers(init?.headers).get("x-axis-expected-profile-subject");
      const path = new URL(String(input)).pathname;
      if (subject === SUBJECT_A && path === "/api/plaid/budget") {
        return { ok: true, json: () => delayedABudget } as Response;
      }
      if (subject === SUBJECT_A && path === "/api/plaid/transactions") {
        return { ok: true, json: () => delayedATransactions } as Response;
      }
      if (subject === SUBJECT_B && path === "/api/plaid/budget") {
        return {
          ok: true,
          json: async () => ({ configured: true, budgets: [], insights: [{ ic: "B", title: "B budget", meta: "B only", value: "$2", up: false }] }),
        } as Response;
      }
      if (subject === SUBJECT_B && path === "/api/plaid/transactions") {
        return {
          ok: true,
          json: async () => ({
            configured: true,
            transactions: [{ id: "b", name: "B transaction", category: "OTHER", amountMinor: -200, currency: "USD", date: "2026-08-09", pending: false }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected protected call ${path} for ${subject}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root?.render(<><FundBudget /><FundTransactions /></>);
    });
    await settle();

    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT_B },
      authorityEpoch: 2,
    });
    flushSync(() => root?.render(<><FundBudget /><FundTransactions /></>));
    expect(container?.textContent).not.toContain("A budget");
    expect(container?.textContent).not.toContain("A transaction");
    await settle();
    expect(container?.textContent).toContain("B budget");
    expect(container?.textContent).toContain("B transaction");

    await act(async () => {
      resolveABudget?.({ configured: true, budgets: [], insights: [{ ic: "A", title: "A budget", meta: "A only", value: "$1", up: false }] });
      resolveATransactions?.({ configured: true, transactions: [{ id: "a", name: "A transaction", category: "OTHER", amountMinor: -100, currency: "USD", date: "2026-08-09", pending: false }] });
      await Promise.resolve();
    });
    await settle();

    expect(container?.textContent).toContain("B budget");
    expect(container?.textContent).toContain("B transaction");
    expect(container?.textContent).not.toContain("A budget");
    expect(container?.textContent).not.toContain("A transaction");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
