import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  timedProviderFetch: vi.fn(),
  getPolygonApiKeyEnv: vi.fn(),
}));

vi.mock("@/lib/observability/providerTiming", () => ({
  timedProviderFetch: mocks.timedProviderFetch,
}));
vi.mock("@/lib/env", () => ({
  getPolygonApiKeyEnv: mocks.getPolygonApiKeyEnv,
}));

import { fetchSnapshot, massiveRequest } from "./client";

function marketStatus(market: "open" | "closed", serverTime: string) {
  return new Response(JSON.stringify({ market, serverTime }), { status: 200 });
}

function snapshotResponse(timestamp?: number, updated = Date.now() * 1_000_000) {
  return new Response(JSON.stringify({
    ticker: {
      day: { c: 100, o: 90 },
      lastTrade: { p: 101, ...(timestamp === undefined ? {} : { t: timestamp }) },
      updated,
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Massive quote provider-time provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolygonApiKeyEnv.mockReturnValue("polygon-key");
  });

  it("retains the provider event timestamp rather than Axis retrieval time", async () => {
    const providerTime = Date.parse("2026-07-23T11:59:00.000Z");
    mocks.timedProviderFetch
      .mockResolvedValueOnce(marketStatus("open", "2026-07-23T12:00:00.000Z"))
      .mockResolvedValueOnce(snapshotResponse(providerTime * 1_000_000))
      .mockResolvedValueOnce(marketStatus("open", "2026-07-23T12:00:01.000Z"));

    const quote = await fetchSnapshot("AAPL");

    expect(quote).toMatchObject({
      source: "massive",
      asOf: "2026-07-23T11:59:00.000Z",
      observedAt: "2026-07-23T12:00:01.000Z",
      marketSession: "open",
    });
  });

  it("rejects a quote with no provider event timestamp", async () => {
    mocks.timedProviderFetch
      .mockResolvedValueOnce(marketStatus("open", "2026-07-23T12:00:00.000Z"))
      .mockResolvedValueOnce(snapshotResponse());

    await expect(fetchSnapshot("AAPL")).rejects.toThrow(
      "QUOTE_TIMESTAMP_UNAVAILABLE",
    );
  });

  it("rejects a provider timestamp in the future", async () => {
    const future = (Date.now() + 120_000) * 1_000_000;
    mocks.timedProviderFetch
      .mockResolvedValueOnce(marketStatus("open", "2026-07-23T12:00:00.000Z"))
      .mockResolvedValueOnce(snapshotResponse(future));

    await expect(fetchSnapshot("AAPL")).rejects.toThrow(
      "QUOTE_TIMESTAMP_UNAVAILABLE",
    );
  });

  it("uses the provider latest-completed-session bar after market close", async () => {
    mocks.timedProviderFetch
      .mockResolvedValueOnce(marketStatus("closed", "2026-07-23T22:00:00.000Z"))
      .mockResolvedValueOnce(snapshotResponse(Date.parse("2026-07-23T19:59:00.000Z") * 1_000_000, Date.parse("2026-07-23T20:01:00.000Z") * 1_000_000))
      .mockResolvedValueOnce(marketStatus("closed", "2026-07-23T22:00:01.000Z"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ c: 102, o: 90, v: 1000, t: Date.parse("2026-07-23T04:00:00.000Z") }],
      }), { status: 200 }));
    const quote = await fetchSnapshot("AAPL");

    expect(quote).toMatchObject({
      price: 102,
      marketSession: "closed",
      latestCompletedSession: true,
      observedAt: "2026-07-23T22:00:01.000Z",
      snapshotUpdatedAt: "2026-07-23T20:01:00.000Z",
    });
  });

  it("rejects a market-session transition during snapshot retrieval", async () => {
    const providerTime = Date.parse("2026-07-23T11:59:00.000Z");
    mocks.timedProviderFetch
      .mockResolvedValueOnce(marketStatus("closed", "2026-07-23T12:00:00.000Z"))
      .mockResolvedValueOnce(snapshotResponse(providerTime * 1_000_000))
      .mockResolvedValueOnce(marketStatus("open", "2026-07-23T12:00:01.000Z"));

    await expect(fetchSnapshot("AAPL")).rejects.toThrow("MARKET_SESSION_CHANGED");
  });

  it("keeps provider credentials out of URLs, errors, and observability metadata", async () => {
    const secret = "polygon-secret-that-must-never-leak";
    mocks.getPolygonApiKeyEnv.mockReturnValue(secret);
    mocks.timedProviderFetch.mockResolvedValue(new Response("provider rejected", {
      status: 503,
    }));

    const error = await massiveRequest("/v3/reference/tickers", {
      search: "axis",
      active: "true",
    }).catch((cause: unknown) => cause);

    expect(error).toEqual(expect.objectContaining({
      message: "Massive API 503",
      status: 503,
    }));
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(mocks.timedProviderFetch).toHaveBeenCalledTimes(1);
    const [url, init, metadata] = mocks.timedProviderFetch.mock.calls[0] as [
      string,
      { headers?: Record<string, string> },
      Record<string, unknown>,
    ];
    expect(url).toBe("https://api.polygon.io/v3/reference/tickers?search=axis&active=true");
    expect(url).not.toContain(secret);
    expect(url).not.toContain("apiKey");
    expect(init.headers).toEqual({ Authorization: `Bearer ${secret}` });
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });
});
