import { afterEach, describe, expect, it, vi } from "vitest";
import { isAxisDesktop, openDesktopBrowser } from "@/lib/desktop-browser";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("desktop browser bridge", () => {
  it("stays disabled in an ordinary browser", async () => {
    expect(isAxisDesktop()).toBe(false);
    await expect(openDesktopBrowser("https://example.com")).resolves.toBe(false);
  });

  it("opens safe web URLs through the Tauri command", async () => {
    const openBrowser = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { axisDesktop: { openBrowser } });

    await expect(openDesktopBrowser("https://example.com/story", "Story")).resolves.toBe(true);
    expect(openBrowser).toHaveBeenCalledWith({
      url: "https://example.com/story",
      title: "Story",
    });
  });

  it("rejects non-web schemes", async () => {
    vi.stubGlobal("window", { axisDesktop: { openBrowser: vi.fn() } });
    await expect(openDesktopBrowser("file:///etc/passwd")).resolves.toBe(false);
  });
});
