// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUBJECT = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  shellProfile: vi.fn(() => ({
    state: "ready",
    profile: { subject: `ps1_${"a".repeat(64)}` },
    authorityEpoch: 1,
  })),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/ui/Card", () => ({ Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/layout/ShellProfileContext", () => ({ useShellProfile: mocks.shellProfile }));

import { FundOrderTicket } from "./FundOrderTicket";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root?.render(<FundOrderTicket />); });
  await act(async () => { await Promise.resolve(); });
}

function setInput(label: string, value: string) {
  const input = container?.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FundOrderTicket intent-only UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT },
      authorityEpoch: 1,
    });
    vi.stubGlobal("React", React);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111") },
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("saves a not-submitted intent through the plural prepare boundary", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ intents: [] }))
      .mockResolvedValueOnce(response({
        submitted: false,
        intent: {
          id: "intent-1",
          symbol: "AAPL",
          side: "buy",
          quantity_units: 1_250_000,
          quantity_scale: 1_000_000,
          reference_price_minor: 19_512,
          currency: "USD",
          status: "not_submitted",
          created_at: "2026-08-09T21:00:00.000Z",
        },
      }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    setInput("Symbol", "AAPL");
    setInput("Shares", "1.25");
    setInput("Reference price per share", "195.12");

    const button = Array.from(container?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent === "Save buy intent") as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); });

    expect(String(fetchMock.mock.calls[1][0])).toBe("http://localhost:3000/api/brokerage/orders");
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(URL), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({}),
    }));
    const requestHeaders = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers);
    expect(requestHeaders.get("x-axis-expected-profile-subject")).toBe(SUBJECT);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      action: "prepare",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      order: { symbol: "AAPL", side: "buy", quantity: "1.25", currency: "USD" },
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("No brokerage order was submitted"),
      "success",
      "Order Intent",
    );
    expect(container?.textContent).toContain("NOT SUBMITTED");
  });

  it("reports persistence failure without any local execution success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ intents: [] }))
      .mockResolvedValueOnce(response({ error: "ORDER_INTENT_CREATE_FAILED" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    setInput("Symbol", "AAPL");
    setInput("Shares", "1");
    setInput("Reference price per share", "195.12");

    const button = Array.from(container?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent === "Save buy intent") as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); });

    expect(mocks.toast).toHaveBeenCalledWith(
      "ORDER_INTENT_CREATE_FAILED",
      "error",
      "Order Intent",
    );
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success", expect.anything());
  });

  it("masks subject A draft and history on the first subject B render", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ intents: [{
      id: "intent-a",
      symbol: "AAPL",
      side: "buy",
      quantity_units: 1_000_000,
      quantity_scale: 1_000_000,
      reference_price_minor: 10_000,
      currency: "USD",
      status: "not_submitted",
      created_at: "2026-08-09T21:00:00.000Z",
    }] })));
    await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container?.textContent).toContain("Buy 1 AAPL");
    await act(async () => { setInput("Shares", "7"); });

    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT_B },
      authorityEpoch: 2,
    });
    flushSync(() => { root?.render(<FundOrderTicket />); });

    expect(container?.textContent).not.toContain("Buy 1 AAPL");
    expect((container?.querySelector('input[aria-label="Shares"]') as HTMLInputElement).value).toBe("");
  });

  it("suppresses a delayed save response and toast from the prior subject", async () => {
    let resolveSave: ((value: unknown) => void) | null = null;
    const delayedBody = new Promise((resolve) => { resolveSave = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ intents: [] }))
      .mockResolvedValueOnce({ ok: true, json: () => delayedBody })
      .mockResolvedValueOnce(response({ intents: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => {
      setInput("Symbol", "AAPL");
      setInput("Shares", "1");
      setInput("Reference price per share", "100.00");
    });
    const button = Array.from(container?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent === "Save buy intent") as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); });

    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: SUBJECT_B },
      authorityEpoch: 2,
    });
    await act(async () => { root?.render(<FundOrderTicket />); await Promise.resolve(); });
    await act(async () => {
      resolveSave?.({
        submitted: false,
        intent: {
          id: "intent-a",
          symbol: "AAPL",
          side: "buy",
          quantity_units: 1_000_000,
          quantity_scale: 1_000_000,
          reference_price_minor: 10_000,
          currency: "USD",
          status: "not_submitted",
          created_at: "2026-08-09T21:00:00.000Z",
        },
      });
      await Promise.resolve();
    });

    expect(container?.textContent).not.toContain("Buy 1 AAPL");
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success", expect.anything());
  });

  it("does not reuse subject A retry identity after switching to subject B", async () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ intents: [] }))
      .mockRejectedValueOnce(new Error("unknown network outcome"))
      .mockResolvedValueOnce(response({ intents: [] }))
      .mockResolvedValueOnce(response({
        submitted: false,
        intent: {
          id: "intent-b",
          symbol: "AAPL",
          side: "buy",
          quantity_units: 1_000_000,
          quantity_scale: 1_000_000,
          reference_price_minor: 10_000,
          currency: "USD",
          status: "not_submitted",
          created_at: "2026-08-09T21:00:00.000Z",
        },
      }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => {
      setInput("Symbol", "AAPL");
      setInput("Shares", "1");
      setInput("Reference price per share", "100.00");
    });
    let button = Array.from(container?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent === "Save buy intent") as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); });

    mocks.shellProfile.mockReturnValue({ state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 });
    await act(async () => { root?.render(<FundOrderTicket />); await Promise.resolve(); });
    await act(async () => {
      setInput("Symbol", "AAPL");
      setInput("Shares", "1");
      setInput("Reference price per share", "100.00");
    });
    button = Array.from(container?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent === "Save buy intent") as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); });

    const first = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const second = JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string);
    expect(first.idempotencyKey).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(second.idempotencyKey).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
