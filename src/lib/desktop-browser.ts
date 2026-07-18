"use client";

type DesktopWindow = Window & {
  axisDesktop?: {
    openBrowser: (input: { url: string; title?: string }) => Promise<boolean>;
  };
};

export function isAxisDesktop(): boolean {
  return typeof window !== "undefined" && Boolean((window as DesktopWindow).axisDesktop);
}

export async function openDesktopBrowser(url: string, title?: string): Promise<boolean> {
  if (!isAxisDesktop()) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  try {
    return await (window as DesktopWindow).axisDesktop!.openBrowser({
      url: parsed.href,
      title: title?.trim() || parsed.hostname.replace(/^www\./, ""),
    });
  } catch {
    return false;
  }
}
