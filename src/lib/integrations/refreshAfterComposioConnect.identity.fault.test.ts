import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForComposioConnectionActive } from "./refreshAfterComposioConnect";

describe("exact Composio OAuth attempt polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not let an existing ACTIVE connection for the same toolkit satisfy a new attempt", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ id: "old-gmail", toolkit: "gmail", status: "ACTIVE" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ id: "new-gmail", toolkit: "gmail", status: "ACTIVE" }] }),
      });

    const pending = waitForComposioConnectionActive("new-gmail", { attempts: 2, delayMs: 20 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns false for a missing exact id even when another same-toolkit account is ACTIVE", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connections: [{ id: "old-gmail", toolkit: "gmail", status: "ACTIVE" }] }),
    });

    const pending = waitForComposioConnectionActive("new-gmail", { attempts: 2, delayMs: 20 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(false);
  });
});
