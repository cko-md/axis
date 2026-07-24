// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function mount(plaidMode: "ready-empty" | "http-error" | "network-error") {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/fund/holdings") return json({ rows: [], aggregated: [] });
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
});
