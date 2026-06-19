"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastType = "success" | "info" | "warn" | "error";

type Toast = {
  id: number;
  message: string;
  type: ToastType;
  label?: string;
};

type ToastContextValue = {
  toast: (message: string, type?: ToastType, label?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastType, string> = {
  success: "✓",
  info: "ℹ",
  warn: "⚠",
  error: "✕",
};

const COLORS: Record<ToastType, string> = {
  success: "var(--up)",
  warn:    "var(--gold)",
  error:   "var(--clay-2)",
  info:    "var(--marine-2)",
};

const BORDER_COLORS: Record<ToastType, string> = {
  success: "color-mix(in srgb, var(--up)     30%, transparent)",
  warn:    "color-mix(in srgb, var(--gold)   30%, transparent)",
  error:   "color-mix(in srgb, var(--clay)   30%, transparent)",
  info:    "color-mix(in srgb, var(--marine) 30%, transparent)",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info", label?: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, message, type, label }]);
    // Errors persist until manually dismissed; others auto-clear after 3.4 s
    if (type !== "error") {
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3400);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex items-start gap-2 rounded px-3 py-2 text-xs shadow-lg animate-[fade_0.3s_ease]"
            style={{
              background: `color-mix(in srgb, ${COLORS[t.type]} 7%, var(--surface-2))`,
              border: `1px solid ${BORDER_COLORS[t.type]}`,
            }}
            role={t.type === "error" ? "alert" : "status"}
          >
            <span style={{ color: COLORS[t.type], flexShrink: 0 }}>{ICONS[t.type]}</span>
            <span className="flex-1">
              {t.label && (
                <span className="mb-0.5 block font-mono text-[9px] uppercase tracking-wider text-[var(--ink-faint)]">
                  {t.label}
                </span>
              )}
              {t.message}
            </span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="ml-1 cursor-pointer border-none bg-transparent p-0 leading-none text-[var(--ink-faint)] hover:text-[var(--ink)]"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
