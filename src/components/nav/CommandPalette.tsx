"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_NAV_ITEMS } from "@/lib/store/nav";
import { useTheme } from "@/components/theme/ThemeProvider";

type Command = {
  id: string;
  label: string;
  hint: string;
  group: "navigate" | "action" | "create";
  icon?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

const GROUP_LABELS: Record<Command["group"], string> = {
  navigate: "Go To",
  action:   "Actions",
  create:   "Create",
};

const GROUP_ORDER: Command["group"][] = ["create", "action", "navigate"];

// Example suggestions shown when the input is empty
const EXAMPLES = [
  "open gallery",
  "new note",
  "interface studio",
  "go to vitality",
  "schedule",
];

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const { openInterfaceStudio } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [exampleIdx, setExampleIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cycle placeholder examples
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setExampleIdx((i) => (i + 1) % EXAMPLES.length), 2200);
    return () => clearInterval(id);
  }, [open]);

  const commands = useMemo<Command[]>(
    () => [
      // ── Create ──────────────────────────────────────────────────────────────
      {
        id: "create-note",
        label: "New Note",
        hint: "Create · notes",
        group: "create",
        icon: "✦",
        run: () => router.push("/notes"),
      },
      {
        id: "create-event",
        label: "New Event",
        hint: "Create · schedule",
        group: "create",
        icon: "✦",
        run: () => router.push("/schedule"),
      },
      {
        id: "create-signal",
        label: "New Signal",
        hint: "Create · dispatch",
        group: "create",
        icon: "✦",
        run: () => router.push("/dispatch"),
      },
      // ── Actions ─────────────────────────────────────────────────────────────
      {
        id: "action-interface-studio",
        label: "Interface Studio",
        hint: "Action · theme & appearance",
        group: "action",
        icon: "◈",
        run: openInterfaceStudio,
      },
      {
        id: "action-gallery-discover",
        label: "Discover Art",
        hint: "Action · gallery",
        group: "action",
        icon: "◈",
        run: () => router.push("/gallery"),
      },
      {
        id: "action-poetry",
        label: "Read Poetry",
        hint: "Action · gallery · poetry",
        group: "action",
        icon: "◈",
        run: () => router.push("/gallery"),
      },
      {
        id: "action-vitality",
        label: "Log Workout",
        hint: "Action · vitality",
        group: "action",
        icon: "◈",
        run: () => router.push("/vitality"),
      },
      // ── Navigation ──────────────────────────────────────────────────────────
      ...ALL_NAV_ITEMS.map((item) => ({
        id: item.href,
        label: item.label,
        hint: `Navigate · ${item.section}`,
        group: "navigate" as const,
        run: () => router.push(item.href),
      })),
    ],
    [router, openInterfaceStudio],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.hint.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q),
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

  // Build grouped display
  const q = query.trim().toLowerCase();
  const groupedItems = q
    ? [{ group: null, items: filtered }]
    : GROUP_ORDER.map((g) => ({ group: g, items: filtered.filter((c) => c.group === g) })).filter((g) => g.items.length > 0);

  // Flat list for activeIdx tracking
  const flatItems = groupedItems.flatMap((g) => g.items);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 p-4 pt-[14vh] backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          background: "var(--surface-1)",
          border: "1px solid var(--line-strong)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 32px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.04) inset",
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid var(--line)",
            padding: "12px 16px",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 15, height: 15, color: "var(--ink-faint)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Try "${EXAMPLES[exampleIdx]}"…`}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 14,
              color: "var(--ink)",
              fontFamily: "var(--sans)",
            }}
          />
          <span className="kbd" style={{ flexShrink: 0 }}>esc</span>
        </div>

        {/* Results */}
        <div style={{ maxHeight: "48vh", overflowY: "auto", padding: "8px 0" }}>
          {flatItems.length === 0 ? (
            <p style={{ padding: "16px 20px", fontSize: 12, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>
              No matches for &ldquo;{query}&rdquo;
            </p>
          ) : (
            groupedItems.map(({ group, items }) => (
              <div key={group ?? "results"}>
                {group && (
                  <div
                    style={{
                      padding: "6px 16px 4px",
                      fontSize: 9,
                      fontFamily: "var(--mono)",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--ink-faint)",
                    }}
                  >
                    {GROUP_LABELS[group]}
                  </div>
                )}
                {items.map((cmd) => {
                  const globalIdx = flatItems.indexOf(cmd);
                  const isActive = globalIdx === activeIdx;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onClick={() => runCommand(cmd)}
                      onMouseEnter={() => setActiveIdx(globalIdx)}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 16px",
                        background: isActive ? "var(--surface-2)" : "transparent",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "background 0.1s",
                      }}
                    >
                      {cmd.icon && (
                        <span
                          style={{
                            fontSize: 10,
                            color: cmd.group === "create"
                              ? "var(--accent)"
                              : cmd.group === "action"
                                ? "var(--gold, #c9a463)"
                                : "var(--ink-faint)",
                            fontFamily: "var(--mono)",
                            width: 14,
                            flexShrink: 0,
                          }}
                        >
                          {cmd.icon}
                        </span>
                      )}
                      <span
                        style={{
                          flex: 1,
                          fontSize: 13.5,
                          color: isActive ? "var(--ink)" : "var(--ink-dim)",
                          fontFamily: "var(--sans)",
                        }}
                      >
                        {cmd.label}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: "var(--mono)",
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          color: "var(--ink-faint)",
                          flexShrink: 0,
                        }}
                      >
                        {cmd.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer — keyboard hints */}
        <div
          style={{
            borderTop: "1px solid var(--line)",
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          {[
            { keys: ["↑", "↓"], label: "Navigate" },
            { keys: ["↵"], label: "Open" },
            { keys: ["esc"], label: "Close" },
          ].map(({ keys, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {keys.map((k) => (
                <span key={k} className="kbd" style={{ fontSize: 9 }}>{k}</span>
              ))}
              <span style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>{label}</span>
            </div>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)", letterSpacing: "0.08em" }}>
            ⌘K to toggle
          </span>
        </div>
      </div>
    </div>
  );
}
