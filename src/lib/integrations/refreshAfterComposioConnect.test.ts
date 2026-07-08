import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  pollComposioConnectionStatus,
  waitForComposioToolkitActive,
} from "./refreshAfterComposioConnect";

describe("pollComposioConnectionStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connections: [] }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hits the composio status endpoint multiple times by default", async () => {
    const promise = pollComposioConnectionStatus();
    await vi.runAllTimersAsync();
    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(global.fetch).toHaveBeenCalledWith("/api/integrations/composio/status", { cache: "no-store" });
  });
});

describe("waitForComposioToolkitActive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns true when the toolkit becomes ACTIVE", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ toolkit: "gmail", status: "INITIALIZING" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ toolkit: "gmail", status: "ACTIVE" }] }),
      });

    const promise = waitForComposioToolkitActive("gmail", { attempts: 4, delayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(true);
  });

  it("returns false when the toolkit hits a dead-end status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connections: [{ toolkit: "gmail", status: "FAILED" }] }),
    });

    const promise = waitForComposioToolkitActive("gmail", { attempts: 2, delayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(false);
  });
});
