import { afterEach, describe, expect, it, vi } from "vitest";
import { isAxisDesktop, openDesktopBrowser } from "@/lib/desktop-browser";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("desktop browser bridge", () => {
  it("stays disabled in an ordinary browser", async () => {
    expect(isAxisDesktop()).toBe(false);
    await expect(openDesktopBrowser("https://example.com")).resolves.toEqual({
      handled: false,
      reason: "not-desktop",
    });
  });

  it("opens safe web URLs through the desktop command", async () => {
    const openBrowser = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { axisDesktop: { openBrowser } });

    await expect(openDesktopBrowser("https://example.com/story", "Story")).resolves.toEqual({
      handled: true,
    });
    expect(openBrowser).toHaveBeenCalledWith({
      url: "https://example.com/story",
      title: "Story",
    });
  });

  it("rejects non-web schemes", async () => {
    const openBrowser = vi.fn();
    vi.stubGlobal("window", { axisDesktop: { openBrowser } });
    await expect(openDesktopBrowser("file:///etc/passwd")).resolves.toEqual({
      handled: false,
      reason: "unsupported-url",
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  // The Topbar's Mini Browser button passes no URL. This previously threw inside
  // `new URL("")`, returned false, and sent the app's primary browser entry point
  // to the in-app iframe on every desktop launch.
  it("forwards an empty URL as an explicit new-tab request", async () => {
    const openBrowser = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { axisDesktop: { openBrowser } });

    await expect(openDesktopBrowser("", "New Tab")).resolves.toEqual({ handled: true });
    expect(openBrowser).toHaveBeenCalledWith({ url: "", title: "New Tab" });
  });

  // A rejection must stay distinguishable from "we are on the web", so callers
  // can report it instead of silently downgrading to the weaker proxy viewer.
  it("reports a main-process rejection as rejected, not as not-desktop", async () => {
    const openBrowser = vi.fn().mockRejectedValue(new Error("Untrusted AXIS browser request"));
    vi.stubGlobal("window", { axisDesktop: { openBrowser } });

    await expect(openDesktopBrowser("https://example.com")).resolves.toEqual({
      handled: false,
      reason: "rejected",
    });
  });

  it("reports a falsy resolution as rejected", async () => {
    const openBrowser = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("window", { axisDesktop: { openBrowser } });

    await expect(openDesktopBrowser("https://example.com")).resolves.toEqual({
      handled: false,
      reason: "rejected",
    });
  });
});
