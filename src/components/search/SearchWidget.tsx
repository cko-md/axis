"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SemanticResult {
  note_id: string;
  similarity: number;
  title?: string;
}

interface QuickResult {
  type: "note" | "task" | "person" | "signal";
  id: string;
  title: string;
  subtitle?: string;
}

const TYPE_ICON: Record<QuickResult["type"], string> = {
  note: "◻",
  task: "✓",
  person: "◯",
  signal: "◈",
};

const TYPE_PATH: Record<QuickResult["type"], string> = {
  note: "/notes",
  task: "/agenda",
  person: "/people",
  signal: "/dispatch",
};

export function SearchWidget() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [semanticResults, setSemanticResults] = useState<SemanticResult[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [quickResults, setQuickResults] = useState<QuickResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const semanticDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setAnswer("");
    setSemanticResults([]);
    setQuickResults([]);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((o) => {
          if (o) { setQuery(""); setAnswer(""); setSemanticResults([]); setQuickResults([]); }
          return !o;
        });
      }
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced quick + semantic search triggered while typing
  useEffect(() => {
    if (semanticDebounceRef.current) clearTimeout(semanticDebounceRef.current);

    if (query.length < 2) {
      setSemanticResults([]);
      setQuickResults([]);
      return;
    }

    const controller = new AbortController();

    semanticDebounceRef.current = setTimeout(async () => {
      setSemanticLoading(true);
      try {
        const [quickRes, semanticRes] = await Promise.allSettled([
          fetch(`/api/search/quick?q=${encodeURIComponent(query)}`, { signal: controller.signal }),
          query.length >= 3
            ? fetch(`/api/search/semantic?q=${encodeURIComponent(query)}`, { signal: controller.signal })
            : Promise.resolve(null),
        ]);

        if (quickRes.status === "fulfilled" && quickRes.value.ok) {
          const data = (await quickRes.value.json()) as { results?: QuickResult[] };
          setQuickResults(data.results ?? []);
        } else {
          setQuickResults([]);
        }

        if (
          semanticRes.status === "fulfilled" &&
          semanticRes.value &&
          semanticRes.value.ok
        ) {
          const data = (await semanticRes.value.json()) as { results?: SemanticResult[] };
          setSemanticResults(data.results ?? []);
        } else {
          setSemanticResults([]);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setQuickResults([]);
        setSemanticResults([]);
      } finally {
        if (!controller.signal.aborted) setSemanticLoading(false);
      }
    }, 300);

    return () => {
      if (semanticDebounceRef.current) clearTimeout(semanticDebounceRef.current);
      controller.abort();
    };
  }, [query]);

  const search = useCallback(async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setAnswer("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json() as { answer?: string; error?: string };
      setAnswer(data.answer ?? data.error ?? "No response.");
    } catch {
      setAnswer("Search unavailable — check your connection.");
    } finally {
      setLoading(false);
    }
  }, [query, loading]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "rgba(10,11,14,0.65)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "18vh",
      }}
      onClick={close}
    >
      <div
        role="dialog"
        aria-label="Axis search"
        style={{
          width: "100%",
          maxWidth: 560,
          margin: "0 16px",
          background: "var(--glass)",
          backdropFilter: "blur(24px)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--rl)",
          boxShadow: "0 32px 80px rgba(0,0,0,.6)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
          {loading ? (
            <svg viewBox="0 0 16 16" style={{ width: 16, height: 16, flexShrink: 0, opacity: 0.5 }} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
              <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z" strokeOpacity="0.3"/>
              <path d="M8 2a6 6 0 0 1 6 6" style={{ animation: "spin 1s linear infinite" }}/>
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="var(--ink-faint)" strokeWidth="1.5" strokeLinecap="round" style={{ width: 16, height: 16, flexShrink: 0 }}>
              <circle cx="6.5" cy="6.5" r="4"/><line x1="10" y1="10" x2="14" y2="14"/>
            </svg>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
            placeholder="Ask Axis anything — tasks, portfolio, schedule…"
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--ink)",
              fontSize: 14,
              fontFamily: "var(--font-sans, inherit)",
            }}
          />
          <kbd style={{
            fontSize: 10,
            color: "var(--ink-faint)",
            fontFamily: "var(--font-mono, monospace)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "1px 5px",
            flexShrink: 0,
          }}>
            {loading ? "…" : "↵"}
          </kbd>
        </div>

        {/* Answer */}
        {answer && (
          <div style={{
            borderTop: "1px solid var(--line)",
            padding: "12px 14px 14px",
          }}>
            <div style={{
              fontSize: 10,
              color: "var(--ink-faint)",
              fontFamily: "var(--font-mono, monospace)",
              letterSpacing: ".1em",
              marginBottom: 8,
            }}>
              ✦ AXIS AI
            </div>
            <p style={{
              fontSize: 13.5,
              color: "var(--ink)",
              lineHeight: 1.7,
              margin: 0,
              whiteSpace: "pre-wrap",
            }}>
              {answer}
            </p>
          </div>
        )}

        {/* Quick keyword matches */}
        {quickResults.length > 0 && (
          <div style={{ borderTop: "1px solid var(--line)" }}>
            <div style={{ padding: "7px 14px 3px", fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--font-mono, monospace)", letterSpacing: ".1em" }}>
              ◻ MATCHES
            </div>
            {quickResults.map((r) => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => {
                  router.push(`${TYPE_PATH[r.type]}?id=${r.id}`);
                  close();
                }}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 14px", background: "none", border: "none", borderTop: "1px solid var(--line)", cursor: "pointer", textAlign: "left" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--surface)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
              >
                <span style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--font-mono, monospace)", minWidth: 12 }}>{TYPE_ICON[r.type]}</span>
                <span style={{ fontSize: 13, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                {r.subtitle && (
                  <span style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--font-mono, monospace)", flexShrink: 0 }}>{r.subtitle}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Semantic matches */}
        {(semanticResults.length > 0 || semanticLoading) && (
          <div style={{ borderTop: "1px solid var(--line)" }}>
            <div style={{
              padding: "8px 14px 4px",
              fontSize: 10,
              color: "var(--ink-faint)",
              fontFamily: "var(--font-mono, monospace)",
              letterSpacing: ".1em",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              ◈ SEMANTIC MATCHES
              {semanticLoading && (
                <svg viewBox="0 0 12 12" style={{ width: 10, height: 10, opacity: 0.5 }} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z" strokeOpacity="0.3"/>
                  <path d="M6 1a5 5 0 0 1 5 5" style={{ animation: "spin 1s linear infinite" }}/>
                </svg>
              )}
            </div>
            {semanticResults.map((r) => (
              <button
                key={r.note_id}
                onClick={() => {
                  router.push(`/notes?note=${r.note_id}`);
                  close();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "7px 14px",
                  background: "none",
                  border: "none",
                  borderTop: "1px solid var(--line)",
                  cursor: "pointer",
                  textAlign: "left",
                  gap: 8,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--surface)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "none";
                }}
              >
                <span style={{
                  fontSize: 13,
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}>
                  {r.title ?? r.note_id}
                </span>
                <span style={{
                  fontSize: 10,
                  color: "var(--ink-faint)",
                  fontFamily: "var(--font-mono, monospace)",
                  flexShrink: 0,
                }}>
                  {(r.similarity * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Footer hint */}
        {!answer && semanticResults.length === 0 && quickResults.length === 0 && !semanticLoading && (
          <div style={{
            borderTop: "1px solid var(--line)",
            padding: "8px 14px",
            display: "flex",
            gap: 12,
            fontSize: 11,
            color: "var(--ink-faint)",
            fontFamily: "var(--font-mono, monospace)",
          }}>
            <span>↵ search</span>
            <span>esc close</span>
            <span style={{ marginLeft: "auto" }}>⌘/ to open</span>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); transform-origin: 8px 8px; } }`}</style>
    </div>
  );
}
