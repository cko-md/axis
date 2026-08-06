import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryDelayMs, timedProviderFetch } from "./providerTiming";

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function response(status: number, body = "{}") {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("providerTiming retry policy", () => {
  it("computes capped exponential retry delays", () => {
    expect(retryDelayMs(1, 100, 1_000)).toBe(100);
    expect(retryDelayMs(2, 100, 1_000)).toBe(200);
    expect(retryDelayMs(5, 100, 1_000)).toBe(1_000);
    expect(retryDelayMs(0, 100, 1_000)).toBe(0);
  });

  it("does not retry unless a retry policy is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(429));
    global.fetch = fetchMock;

    const res = await timedProviderFetch("https://example.test/data", {}, {
      area: "test",
      provider: "example",
      operation: "read",
    });

    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient statuses with bounded backoff", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, "{\"ok\":true}"));
    global.fetch = fetchMock;

    const res = await timedProviderFetch("https://example.test/data", {}, {
      area: "test",
      provider: "example",
      operation: "read",
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it("retries network errors and returns the later success", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket closed"))
      .mockResolvedValueOnce(response(200));
    global.fetch = fetchMock;

    const res = await timedProviderFetch("https://example.test/data", {}, {
      area: "test",
      provider: "example",
      operation: "read",
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        sleep: async () => {},
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
