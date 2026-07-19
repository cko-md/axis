"use client";

type DesktopWindow = Window & {
  axisDesktop?: {
    openBrowser: (input: { url: string; title?: string }) => Promise<boolean>;
  };
};

/**
 * Why a request did not open in the native Electron browser.
 *
 * This used to be a bare `false`, which collapsed three very different outcomes
 * — "we are in an ordinary web browser", "the main process rejected the
 * request", and "that URL is not something we can open" — into one value.
 * Callers treated all three as "fall back to the in-app iframe", so a genuine
 * desktop failure silently downgraded to the weaker proxy viewer with nothing
 * logged. Only `not-desktop` is a legitimate reason to render the web fallback.
 */
export type DesktopBrowserResult =
  | { handled: true }
  | { handled: false; reason: "not-desktop" | "rejected" | "unsupported-url" };

export function isAxisDesktop(): boolean {
  return typeof window !== "undefined" && Boolean((window as DesktopWindow).axisDesktop);
}

export async function openDesktopBrowser(
  url: string,
  title?: string,
): Promise<DesktopBrowserResult> {
  if (!isAxisDesktop()) return { handled: false, reason: "not-desktop" };

  // An empty url is the explicit "open the browser with no page yet" case (the
  // Topbar's Mini Browser button) and is forwarded as such. Previously `new
  // URL("")` threw here and returned false, so the app's primary browser entry
  // point ALWAYS fell through to the iframe, even on desktop.
  const trimmed = (url ?? "").trim();
  let href = "";
  let fallbackTitle = "New Tab";

  if (trimmed.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { handled: false, reason: "unsupported-url" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { handled: false, reason: "unsupported-url" };
    }
    href = parsed.href;
    fallbackTitle = parsed.hostname.replace(/^www\./, "");
  }

  try {
    const opened = await (window as DesktopWindow).axisDesktop!.openBrowser({
      url: href,
      title: title?.trim() || fallbackTitle,
    });
    return opened ? { handled: true } : { handled: false, reason: "rejected" };
  } catch {
    return { handled: false, reason: "rejected" };
  }
}
