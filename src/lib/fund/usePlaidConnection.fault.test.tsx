// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  openPlaidLink: vi.fn(),
  shellProfile: vi.fn(),
  plaidOptions: null as null | { token?: string | null; onSuccess?: (...args: unknown[]) => unknown },
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: (options: { token?: string | null; onSuccess?: (...args: unknown[]) => unknown }) => {
    mocks.plaidOptions = options;
    return { open: mocks.openPlaidLink, ready: false };
  },
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/layout/ShellProfileContext", () => ({
  useShellProfile: mocks.shellProfile,
}));

import { usePlaidConnection } from "./usePlaidConnection";

type HookValue = ReturnType<typeof usePlaidConnection>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: HookValue | null = null;

function response(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;

function Harness() {
  latest = usePlaidConnection();
  return null;
}

async function settle() {
  for (let index = 0; index < 5; index++) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function mount(accounts: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/plaid/status")) return response({ configured: true, linked: true });
    if (url.endsWith("/api/brokerage/status")) return response({ configured: false });
    if (url.endsWith("/api/plaid/balances")) return response({
      configured: true,
      completeness: "complete",
      accounts,
    });
    throw new Error(`Unexpected URL ${url}`);
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
  await settle();
  return latest as HookValue;
}

describe("signed-in Plaid cash availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT_A },
      authorityEpoch: 1,
    });
    latest = null;
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

  it("preserves an explicit provider zero as available cash", async () => {
    const value = await mount([{
      name: "Checking",
      mask: "1234",
      subtype: "checking",
      type: "depository",
      current: "0.00",
      currentMinor: 0,
      currency: "USD",
    }]);

    expect(value.cash).toBe("0.00");
    expect(value.cashMinor).toBe(0);
    expect(value.cashReason).toBeNull();
    expect(value.balanceError).toBe(false);
  });

  it.each([
    ["missing amount", null, "USD", "CASH_AMOUNT_UNAVAILABLE"],
    ["non-USD currency", 1_000, "EUR", "MIXED_CURRENCY_REQUIRES_FX"],
  ])("returns null with a typed reason for %s", async (_label, currentMinor, currency, reason) => {
    const value = await mount([{
      name: "Checking",
      mask: "1234",
      subtype: "checking",
      type: "depository",
      current: currentMinor === null ? null : "10.00",
      currentMinor,
      currency,
    }]);

    expect(value.cash).toBeNull();
    expect(value.cashReason).toBe(reason);
  });

  it("does not blend credit balances into cash", async () => {
    const value = await mount([{
      name: "Card",
      mask: "9999",
      subtype: "credit card",
      type: "credit",
      current: "250.00",
      currentMinor: 25_000,
      currency: "USD",
    }]);

    expect(value.cash).toBeNull();
    expect(value.cashReason).toBe("ACCOUNT_TYPE_REQUIRES_PARTITION");
  });

  it("clears a previously loaded numeric balance after a provider refresh failure", async () => {
    const value = await mount([{
      name: "Checking",
      mask: "1234",
      subtype: "checking",
      type: "depository",
      current: "25.00",
      currentMinor: 2_500,
      currency: "USD",
    }]);
    expect(value.cash).toBe("25.00");
    expect(value.cashMinor).toBe(2_500);

    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("provider unavailable"));
    await act(async () => {
      await value.reloadBalances();
    });

    expect(latest?.cash).toBeNull();
    expect(latest?.cashReason).toBe("PLAID_BALANCES_FAILED");
    expect(latest?.bankAccounts).toEqual([]);
    expect(latest?.balanceError).toBe(true);
  });

  it("masks subject A cash immediately and ignores delayed A bodies after switching to B", async () => {
    const value = await mount([{
      name: "Checking A", mask: "1234", subtype: "checking", type: "depository",
      current: "25.00", currentMinor: 2_500, currency: "USD",
    }]);
    expect(value.cash).toBe("25.00");
    let resolveBStatus: ((value: unknown) => void) | null = null;
    const delayedBStatus = new Promise((resolve) => { resolveBStatus = resolve; });
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plaid/status")) return { ok: true, json: () => delayedBStatus } as Response;
      if (url.endsWith("/api/brokerage/status")) return response({ configured: false });
      if (url.endsWith("/api/plaid/balances")) return response({ configured: true, completeness: "complete", accounts: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT_B },
      authorityEpoch: 2,
    });
    flushSync(() => { root?.render(<Harness />); });

    expect(latest?.cash).toBeNull();
    expect(latest?.bankAccounts).toEqual([]);
    expect(latest?.plaidStatusState).toBe("loading");
    await act(async () => {
      resolveBStatus?.({ configured: true, linked: false });
      await Promise.resolve();
    });
    expect(latest?.cash).toBeNull();
  });

  it("adds the exact expected-subject header to status and balance requests", async () => {
    await mount([]);

    const protectedCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([input]) =>
      /\/api\/(?:plaid|brokerage)\//.test(String(input)),
    );
    expect(protectedCalls.length).toBeGreaterThan(0);
    for (const [, init] of protectedCalls) {
      expect(new Headers(init?.headers).get("x-axis-expected-profile-subject")).toBe(SUBJECT_A);
    }
  });

  it("does not retain a delayed subject A Link token after switching to B", async () => {
    const value = await mount([]);
    let resolveToken: ((value: unknown) => void) | null = null;
    const delayedToken = new Promise((resolve) => { resolveToken = resolve; });
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plaid/link")) return { ok: true, json: () => delayedToken } as Response;
      if (url.endsWith("/api/plaid/status")) return response({ configured: true, linked: false });
      if (url.endsWith("/api/brokerage/status")) return response({ configured: false });
      throw new Error(`Unexpected URL ${url}`);
    });
    const pending = value.connectBank();
    await act(async () => { await Promise.resolve(); });

    mocks.shellProfile.mockReturnValue({ state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 });
    await act(async () => { root?.render(<Harness />); await Promise.resolve(); });
    await act(async () => { resolveToken?.({ link_token: "subject-a-token" }); await pending; });

    expect(mocks.plaidOptions?.token).not.toBe("subject-a-token");
    expect(mocks.openPlaidLink).not.toHaveBeenCalled();
  });

  it("suppresses a delayed subject A exchange success and toast under B", async () => {
    const value = await mount([]);
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plaid/link")) return response({ link_token: "subject-a-token" });
      if (url.endsWith("/api/plaid/status")) return response({ configured: true, linked: false });
      if (url.endsWith("/api/brokerage/status")) return response({ configured: false });
      throw new Error(`Unexpected URL ${url}`);
    });
    await act(async () => { await value.connectBank(); });
    const onSuccess = mocks.plaidOptions?.onSuccess;
    expect(onSuccess).toBeTypeOf("function");
    let resolveExchange: ((value: Response) => void) | null = null;
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plaid/exchange")) return new Promise<Response>((resolve) => { resolveExchange = resolve; });
      if (url.endsWith("/api/plaid/status")) return response({ configured: true, linked: false });
      if (url.endsWith("/api/brokerage/status")) return response({ configured: false });
      throw new Error(`Unexpected URL ${url}`);
    });
    const pending = onSuccess?.("public-token", { institution: { name: "Bank" } });
    await act(async () => { await Promise.resolve(); });

    mocks.shellProfile.mockReturnValue({ state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 });
    await act(async () => { root?.render(<Harness />); await Promise.resolve(); });
    await act(async () => { resolveExchange?.(response({ ok: true })); await pending; });

    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("Bank linked"), "success", "Plaid");
    expect(latest?.plaidLinked).toBe(false);
  });
});
