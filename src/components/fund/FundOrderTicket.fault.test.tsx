// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/ui/Card", () => ({ Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

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

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/brokerage/orders", expect.objectContaining({ method: "POST" }));
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
});
