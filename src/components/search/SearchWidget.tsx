"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function SearchWidget() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setAnswer("");
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((o) => {
          if (o) { setQuery(""); setAnswer(""); }
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

        {/* Footer hint */}
        {!answer && (
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
