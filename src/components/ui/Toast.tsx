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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info", label?: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, message, type, label }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === "error" ? 5200 : 3400);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex items-start gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-xs shadow-lg animate-[fade_0.3s_ease]"
            role="status"
          >
            <span className="text-[var(--accent)]">{ICONS[t.type]}</span>
            <span>
              {t.label && (
                <span className="mb-0.5 block font-mono text-[9px] uppercase tracking-wider text-[var(--ink-faint)]">
                  {t.label}
                </span>
              )}
              {t.message}
            </span>
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
