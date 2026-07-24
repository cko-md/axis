"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";

type Citation = {
  summary: string;
  data_sources: string[];
  assumptions: string;
  confidence: "high" | "medium" | "low";
  requires_review: boolean;
};

export type AdvisorEvidence = {
  source: string;
  title: string;
  facts: string[];
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  citation?: Citation | null;
  evidence?: AdvisorEvidence[];
  toolCallCount?: number;
};

export function AdvisorEvidenceView({
  evidence,
}: {
  evidence: readonly AdvisorEvidence[];
}) {
  if (evidence.length === 0) return null;
  return (
    <div
      aria-label="Verified evidence"
      style={{
        marginTop: 6,
        fontSize: 11,
        color: "var(--ink-dim)",
        background: "var(--surface-1)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "9px 11px",
      }}
    >
      <b>Verified evidence</b>
      {evidence.map((item, index) => (
        <section key={`${item.source}-${index}`} style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 600 }}>{item.title}</div>
          <ul style={{ margin: "3px 0 0", paddingLeft: 17 }}>
            {item.facts.map((fact, factIndex) => (
              <li key={factIndex}>{fact}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * FIN-508: Advisor chat UI. Reuses the .cp-msg/.cp-you/.cp-ai/.cp-input-bar
 * bubble classes from the Mascot popout (Mascot.tsx) since the visual
 * language already exists — this is a full-page layout instead of a
 * popout, so .cp-msgs' fixed max-height is overridden inline.
 *
 * Every assistant reply that came with a citation (i.e. touched the
 * user's actual data) renders its data_sources/assumptions/confidence/
 * requires_review footer — this is the UI half of Phase 5's citation
 * contract, not optional decoration.
 */
export function FundAdvisorModule() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError(null);
    setMessages((p) => [...p, { role: "user", content: text }]);
    setLoading(true);
    try {
      const res = await fetch("/api/fund/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, message: text }),
      });
      const data = (await res.json()) as {
        conversation_id?: string;
        text?: string;
        citation?: Citation | null;
        evidence?: AdvisorEvidence[];
        tool_call_count?: number;
        error?: string;
      };
      if (res.status === 503) {
        setError(
          data.error === "ANTHROPIC_API_KEY_NOT_CONFIGURED"
            ? "Set ANTHROPIC_API_KEY to enable the advisor."
            : data.error === "ADVISOR_EVIDENCE_UNAVAILABLE"
              ? "Verified financial data could not be rendered safely. Try again."
              : "The advisor is temporarily unavailable. Try again.",
        );
        setMessages((p) => p.slice(0, -1));
        return;
      }
      if (res.status === 429) {
        setError("Rate limit hit — wait a minute and try again.");
        setMessages((p) => p.slice(0, -1));
        return;
      }
      if (data.error) {
        setError(data.error);
        setMessages((p) => p.slice(0, -1));
        return;
      }
      setConversationId(data.conversation_id);
      setMessages((p) => [...p, {
        role: "assistant",
        content: data.text ?? "…",
        citation: data.citation,
        evidence: data.evidence,
        toolCallCount: data.tool_call_count,
      }]);
    } catch {
      setError("Connection lost — try again.");
      setMessages((p) => p.slice(0, -1));
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, conversationId]);

  return (
    <Card tick>
      <h2 className="sec">AI Advisor<span className="rule" /><span className="count">Read-only · no trading</span></h2>

      <div className="cp-msgs" style={{ maxHeight: "none", minHeight: 320, padding: "14px 0" }}>
        {messages.length === 0 && !loading && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            Ask about your spending, holdings, budgets, or whether you can afford something. Every answer that touches your
            data comes with its sources and a confidence level — this does not place trades.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i}>
            <div className={`cp-msg ${m.role === "user" ? "cp-you" : "cp-ai"}`}>
              <span>{m.content}</span>
            </div>
            {m.evidence && <AdvisorEvidenceView evidence={m.evidence} />}
            {m.citation && (
              <div
                style={{
                  marginTop: 4,
                  marginLeft: m.role === "assistant" ? 0 : "auto",
                  fontSize: 10.5,
                  color: "var(--ink-faint)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  padding: "8px 11px",
                  lineHeight: 1.6,
                }}
              >
                <div>
                  <b style={{ color: "var(--ink-dim)" }}>Sources:</b> {m.citation.data_sources.join(", ") || "none"}
                  {typeof m.toolCallCount === "number" && m.toolCallCount > 0 && ` · ${m.toolCallCount} tool call${m.toolCallCount > 1 ? "s" : ""}`}
                </div>
                {m.citation.assumptions && <div><b style={{ color: "var(--ink-dim)" }}>Assumptions:</b> {m.citation.assumptions}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                  <span style={{ color: m.citation.confidence === "high" ? "var(--up)" : m.citation.confidence === "low" ? "var(--clay)" : "var(--gold)" }}>
                    Confidence: {m.citation.confidence}
                  </span>
                  {m.citation.requires_review && <span style={{ color: "var(--clay)" }}>⚠ Worth double-checking</span>}
                </div>
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="cp-msg cp-ai cp-typing">
            <span className="cp-dots"><span /><span /><span /></span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ fontSize: 11.5, color: "var(--clay)", marginBottom: 6 }}>{error}</p>}

      <div className="cp-input-bar" style={{ padding: "10px 0 0", borderTop: "1px solid var(--line)" }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Can I afford a $400 flight this month?"
          className="cp-input"
          disabled={loading}
        />
        <button type="button" onClick={() => void send()} className="cp-send" disabled={loading || !input.trim()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" /></svg>
        </button>
      </div>
    </Card>
  );
}
