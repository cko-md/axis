// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shellProfile: vi.fn(),
}));

vi.mock("@/components/layout/ShellProfileContext", () => ({
  useShellProfile: mocks.shellProfile,
}));

import { FundDataProvider, useFundData } from "./FundDataProvider";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useFundData> | null = null;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function Harness({ children }: { children?: ReactNode }) {
  latest = useFundData();
  return children ?? null;
}

async function mount(
  plaidMode: "ready-empty" | "http-error" | "network-error",
  holdingPayload: { rows: unknown[]; aggregated: unknown[] } = { rows: [], aggregated: [] },
) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/fund/holdings") return json(holdingPayload);
    if (url === "/api/fund/liabilities") {
      if (plaidMode === "network-error") throw new Error("provider unavailable");
      if (plaidMode === "http-error") return json({ error: "provider_error" }, 502);
      return json({
        liabilities: [],
        providerAvailability: [{
          availability_status: "available",
          availability_reason: null,
        }],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<FundDataProvider><Harness /></FundDataProvider>);
  });
  for (let index = 0; index < 5; index++) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  return latest as ReturnType<typeof useFundData>;
}

describe("Plaid liability availability state", () => {
  beforeEach(() => {
    latest = null;
    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: "ps1_" + "a".repeat(64) },
      authorityEpoch: 1,
    });
    vi.stubGlobal("React", React);
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

  it.each(["http-error", "network-error"] as const)(
    "keeps a Plaid liability %s distinct from an empty result",
    async (mode) => {
      const value = await mount(mode);

      expect(value.plaidLiabilitiesState).toBe("unavailable");
      expect(value.plaidLiabilitiesConnected).toBeNull();
      expect(value.plaidLiabilities).toEqual([]);
    },
  );

  it("represents a successful connected empty response as ready-empty", async () => {
    const value = await mount("ready-empty");

    expect(value.plaidLiabilitiesState).toBe("ready");
    expect(value.plaidLiabilitiesConnected).toBe(true);
    expect(value.plaidLiabilities).toEqual([]);
  });

  it("preserves the last successful holdings snapshot when refresh fails", async () => {
    const holding = { id: "holding-1", symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, source: "manual" };
    const aggregate = { symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, sources: ["manual"] };
    await mount("ready-empty", { rows: [holding], aggregated: [aggregate] });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/fund/holdings") return json({ error: "unavailable" }, 503);
      return json({ liabilities: [], providerAvailability: [] });
    });

    await act(async () => {
      await latest?.refreshHoldings();
    });

    expect(latest?.holdingsError).toBe(true);
    expect(latest?.rows).toEqual([holding]);
    expect(latest?.aggregated).toEqual([aggregate]);
  });

  it("clears cached holdings when authentication is lost", async () => {
    const holding = { id: "holding-1", symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, source: "manual" };
    const aggregate = { symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, sources: ["manual"] };
    await mount("ready-empty", { rows: [holding], aggregated: [aggregate] });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/fund/holdings") return json({ error: "UNAUTHORIZED" }, 401);
      return json({ liabilities: [], providerAvailability: [] });
    });

    await act(async () => {
      await latest?.refreshHoldings();
    });

    expect(latest?.signedIn).toBe(false);
    expect(latest?.holdingsError).toBe(false);
    expect(latest?.rows).toEqual([]);
    expect(latest?.aggregated).toEqual([]);
  });

  it("never exposes subject A holdings after a direct switch to subject B fails", async () => {
    const holding = { id: "holding-1", symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, source: "manual" };
    const aggregate = { symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, sources: ["manual"] };
    await mount("ready-empty", { rows: [holding], aggregated: [aggregate] });
    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: "ps1_" + "b".repeat(64) },
      authorityEpoch: 2,
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/fund/holdings") return json({ error: "unavailable" }, 503);
      return json({ liabilities: [], providerAvailability: [] });
    });

    await act(async () => {
      root?.render(<FundDataProvider><Harness /></FundDataProvider>);
    });
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    expect(latest?.holdingsError).toBe(true);
    expect(latest?.rows).toEqual([]);
    expect(latest?.aggregated).toEqual([]);
  });

  it("ignores a late subject A response after subject B becomes authoritative", async () => {
    const holdingA = { id: "holding-a", symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, source: "manual" };
    const aggregateA = { symbol: "AAPL", name: "Apple", shares: 1, cost_basis: 100, sources: ["manual"] };
    const holdingB = { id: "holding-b", symbol: "MSFT", name: "Microsoft", shares: 2, cost_basis: 200, source: "manual" };
    const aggregateB = { symbol: "MSFT", name: "Microsoft", shares: 2, cost_basis: 200, sources: ["manual"] };
    let resolveSubjectA: ((response: Response) => void) | null = null;
    let holdingsCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/fund/holdings") {
        holdingsCalls += 1;
        if (holdingsCalls === 1) {
          return new Promise<Response>((resolve) => { resolveSubjectA = resolve; });
        }
        return Promise.resolve(json({ rows: [holdingB], aggregated: [aggregateB] }));
      }
      return Promise.resolve(json({ liabilities: [], providerAvailability: [] }));
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<FundDataProvider><Harness /></FundDataProvider>);
    });
    await act(async () => { await Promise.resolve(); });

    mocks.shellProfile.mockReturnValue({
      state: "ready",
      profile: { subject: "ps1_" + "b".repeat(64) },
      authorityEpoch: 2,
    });
    await act(async () => {
      root?.render(<FundDataProvider><Harness /></FundDataProvider>);
    });
    for (let index = 0; index < 3; index++) {
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    }
    expect(latest?.rows).toEqual([holdingB]);

    await act(async () => {
      resolveSubjectA?.(json({ rows: [holdingA], aggregated: [aggregateA] }));
      await Promise.resolve();
    });

    expect(latest?.rows).toEqual([holdingB]);
    expect(latest?.aggregated).toEqual([aggregateB]);
  });
});
