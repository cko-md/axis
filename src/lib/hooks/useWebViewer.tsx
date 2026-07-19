"use client";

import { createContext, useCallback, useContext, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { openDesktopBrowser } from "@/lib/desktop-browser";

type ViewerEntry = { url: string; title?: string };
type WebViewerCtx = {
  open: (url: string, title?: string) => void;
  close: () => void;
  current: ViewerEntry | null;
};

const Ctx = createContext<WebViewerCtx | null>(null);

export function WebViewerProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ViewerEntry | null>(null);
  const open = useCallback((url: string, title?: string) => {
    void openDesktopBrowser(url, title).then((result) => {
      if (result.handled) return;
      // On desktop the native browser is the intended surface. Falling back to
      // the proxy iframe there would hide a real failure behind a strictly less
      // capable viewer, so report it and keep the fallback for the web build.
      if (result.reason !== "not-desktop") {
        Sentry.captureMessage("Desktop browser request was not handled", {
          level: "warning",
          tags: { feature: "web-viewer", reason: result.reason },
        });
      }
      setCurrent({ url, title });
    });
  }, []);
  const close = useCallback(() => setCurrent(null), []);
  return <Ctx.Provider value={{ open, close, current }}>{children}</Ctx.Provider>;
}

export function useWebViewer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWebViewer must be inside WebViewerProvider");
  return ctx;
}
