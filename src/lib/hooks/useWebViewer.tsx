"use client";

import { createContext, useCallback, useContext, useState } from "react";

type ViewerEntry = { url: string; title?: string };
type WebViewerCtx = {
  open: (url: string, title?: string) => void;
  close: () => void;
  current: ViewerEntry | null;
};

const Ctx = createContext<WebViewerCtx | null>(null);

export function WebViewerProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ViewerEntry | null>(null);
  const open = useCallback((url: string, title?: string) => setCurrent({ url, title }), []);
  const close = useCallback(() => setCurrent(null), []);
  return <Ctx.Provider value={{ open, close, current }}>{children}</Ctx.Provider>;
}

export function useWebViewer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWebViewer must be inside WebViewerProvider");
  return ctx;
}
