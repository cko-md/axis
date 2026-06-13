"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_NAV_ITEMS } from "@/lib/store/nav";
import { useTheme } from "@/components/theme/ThemeProvider";

type Command = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const { openInterfaceStudio } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(
    () => [
      ...ALL_NAV_ITEMS.map((item) => ({
        id: item.href,
        label: item.label,
        hint: `Go to · ${item.section}`,
        run: () => router.push(item.href),
      })),
      {
        id: "action-interface-studio",
        label: "Interface Studio",
        hint: "Open · theme & appearance",
        run: openInterfaceStudio,
      },
    ],
    [router, openInterfaceStudio],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const runCommand = useCallback(
    (cmd: Command) => {
      onClose();
      setQuery("");
      cmd.run();
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // focus after the overlay paints
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter" && filtered[activeIdx]) {
        e.preventDefault();
        runCommand(filtered[activeIdx]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, activeIdx, onClose, runCommand]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/55 p-4 pt-[14vh] backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="card w-full max-w-lg border border-[var(--line-strong)] p-0 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 15, height: 15, color: "var(--ink-faint)" }}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a module or action…"
            className="w-full bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="max-h-[46vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-xs text-[var(--ink-faint)]">No matches.</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                type="button"
                onClick={() => runCommand(cmd)}
                onMouseEnter={() => setActiveIdx(i)}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition ${
                  i === activeIdx ? "bg-[var(--surface-2)] text-[var(--ink)]" : "text-[var(--ink-dim)]"
                }`}
              >
                <span>{cmd.label}</span>
                <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--ink-faint)]">{cmd.hint}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
