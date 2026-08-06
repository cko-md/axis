import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: mocks.addBreadcrumb,
  captureException: mocks.captureException,
}));

import { timedProviderFetch } from "./providerTiming";

const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.addBreadcrumb.mockReset();
  mocks.captureException.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("provider timing fallback ownership", () => {
  it("keeps safe timing while the consumer owns fallback telemetry", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("provider offline"));

    await expect(timedProviderFetch("https://example.test/data", {}, {
      area: "test",
      provider: "example",
      operation: "read",
      captureFailures: false,
      recordBreadcrumbs: false,
    })).rejects.toThrow("provider offline");

    expect(console.info).toHaveBeenCalledWith(
      "[axis:provider]",
      expect.stringContaining('"outcome":"error"'),
    );
    expect(mocks.addBreadcrumb).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("still records and captures the identical live provider failure by default", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("provider offline"));

    await expect(timedProviderFetch("https://example.test/data", {}, {
      area: "test",
      provider: "example",
      operation: "read",
    })).rejects.toThrow("provider offline");

    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: "provider.failure",
      level: "error",
    }));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});
