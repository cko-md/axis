import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { pollComposioConnectionStatus } from "./refreshAfterComposioConnect";

describe("pollComposioConnectionStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
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

  it("respects a custom attempt count", async () => {
    const promise = pollComposioConnectionStatus({ attempts: 2, delayMs: 100 });
    await vi.runAllTimersAsync();
    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
