// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;
let shell = { state: "ready", profile: { subject: SUBJECT_A }, authorityEpoch: 1 };
vi.mock("@/components/layout/ShellProfileContext", () => ({ useShellProfile: () => shell }));
vi.mock("@/components/ui/FreshnessBadge", () => ({ FreshnessBadge: () => <span data-freshness /> }));

import { NetWorthChart } from "./NetWorthChart";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function snapshot(netWorth: string) {
  return {
    captured_on: "2026-08-09",
    cash: "100.00",
    invested: "200.00",
    liabilities: "50.00",
    net_worth: netWorth,
    computed_at: "2026-08-09T12:00:00.000Z",
    input_as_of: "2026-08-09T11:59:00.000Z",
    authority: "provider",
    snapshot_status: "fresh",
    currency: "USD",
    calculation_version: "financial-truth-v2",
  };
}

async function render() {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root?.render(<NetWorthChart signedIn showHeadline />); });
}

describe("net worth snapshot presentation", () => {
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

  it("shows the latest provider-verified amount even with one day of history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ snapshots: [snapshot("250.00")] }))));

    await render();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container?.textContent).toContain("$250.00");
    expect(container?.textContent).toContain("Provider-verified snapshot");
    expect(container?.textContent).toContain("Building history");
  });

  it("formats the maximum safe minor-unit headline without losing a cent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ snapshots: [snapshot("90071992547409.91")] }))));

    await render();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container?.textContent).toContain("$90,071,992,547,409.91");
  });

  it("turns a malformed response body into a visible unavailable state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } })));

    await render();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container?.textContent).toContain("Net worth unavailable");
    expect(container?.textContent).not.toContain("Loading provider-verified net worth");
  });

  it("masks subject A synchronously on the first subject B render", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ snapshots: [snapshot("250.00")] }));
      return { ok: true, json: () => new Promise(() => undefined) };
    }));
    await render();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container?.textContent).toContain("$250.00");

    shell = { state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 };
    flushSync(() => { root?.render(<NetWorthChart signedIn showHeadline />); });

    expect(container?.textContent).not.toContain("$250.00");
    expect(container?.textContent).toContain("Loading provider-verified net worth");
  });

  it("suppresses a delayed response from the prior subject", async () => {
    let resolveA: ((value: unknown) => void) | null = null;
    const bodyA = new Promise((resolve) => { resolveA = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => bodyA })
      .mockResolvedValueOnce(new Response(JSON.stringify({ snapshots: [snapshot("999.00")] })));
    vi.stubGlobal("fetch", fetchMock);
    await render();

    shell = { state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 };
    await render();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { resolveA?.({ snapshots: [snapshot("250.00")] }); await Promise.resolve(); });

    expect(container?.textContent).toContain("$999.00");
    expect(container?.textContent).not.toContain("$250.00");
  });
});
