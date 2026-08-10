"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type Citation = {
  summary: string;
  data_sources: string[];
  assumptions: string;
  confidence: "high" | "medium" | "low";
  requires_review: boolean;
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  citation?: Citation | null;
  toolCallCount?: number;
};

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
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const requestGenerationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [conversationIdentity, setConversationIdentity] = useState<string | null>(currentIdentity);

  useEffect(() => {
    ++requestGenerationRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setMessages([]);
    setInput("");
    setLoading(false);
    setConversationId(undefined);
    setError(null);
    setConversationIdentity(currentIdentity);
  }, [currentIdentity]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const expectedIdentity = expectedSubject ? `${expectedSubject}:${expectedEpoch}` : null;
    const ownsConversation = conversationIdentity === expectedIdentity;
    const text = (ownsConversation ? input : "").trim();
    if (!expectedSubject || !text || (ownsConversation && loading)) return;
    const generation = ++requestGenerationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => !controller.signal.aborted
      && requestGenerationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    setInput("");
    setError(null);
    setMessages((p) => [...p, { role: "user", content: text }]);
    setLoading(true);
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/fund/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: ownsConversation ? conversationId : undefined, message: text }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (res.status === 503) {
        setError("Set ANTHROPIC_API_KEY to enable the advisor.");
        setMessages((p) => p.slice(0, -1));
        return;
      }
      if (res.status === 429) {
        setError("Rate limit hit — wait a minute and try again.");
        setMessages((p) => p.slice(0, -1));
        return;
      }
      const data = (await res.json()) as {
        conversation_id?: string;
        text?: string;
        citation?: Citation | null;
        tool_call_count?: number;
        error?: string;
      };
      if (!isCurrent()) return;
      if (data.error) {
        setError(data.error);
        setMessages((p) => p.slice(0, -1));
        return;
      }
      setConversationId(data.conversation_id);
      setConversationIdentity(expectedIdentity);
      setMessages((p) => [...p, { role: "assistant", content: data.text ?? "…", citation: data.citation, toolCallCount: data.tool_call_count }]);
    } catch {
      if (isCurrent()) {
        setError("Connection lost — try again.");
        setMessages((p) => p.slice(0, -1));
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setTimeout(() => {
          if (isCurrent()) inputRef.current?.focus();
        }, 50);
      }
    }
  }, [authorityEpoch, conversationId, conversationIdentity, currentSubject, input, loading]);

  const ownsConversation = conversationIdentity === currentIdentity;
  const visibleMessages = ownsConversation ? messages : [];
  const visibleInput = ownsConversation ? input : "";
  const visibleLoading = ownsConversation && loading;
  const visibleError = ownsConversation ? error : null;

  return (
    <Card tick>
      <h2 className="sec">AI Advisor<span className="rule" /><span className="count">Read-only · no trading</span></h2>

      <div className="cp-msgs" style={{ maxHeight: "none", minHeight: 320, padding: "14px 0" }}>
        {visibleMessages.length === 0 && !visibleLoading && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            Ask about your spending, holdings, budgets, or whether you can afford something. Every answer that touches your
            data comes with its sources and a confidence level — this does not place trades.
          </p>
        )}
        {visibleMessages.map((m, i) => (
          <div key={i}>
            <div className={`cp-msg ${m.role === "user" ? "cp-you" : "cp-ai"}`}>
              <span>{m.content}</span>
            </div>
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
        {visibleLoading && (
          <div className="cp-msg cp-ai cp-typing">
            <span className="cp-dots"><span /><span /><span /></span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {visibleError && <p style={{ fontSize: 11.5, color: "var(--clay)", marginBottom: 6 }}>{visibleError}</p>}

      <div className="cp-input-bar" style={{ padding: "10px 0 0", borderTop: "1px solid var(--line)" }}>
        <input
          ref={inputRef}
          value={visibleInput}
          onChange={(e) => {
            if (!ownsConversation) setConversationIdentity(currentIdentity);
            setInput(e.target.value);
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Can I afford a $400 flight this month?"
          className="cp-input"
          disabled={visibleLoading}
        />
        <button type="button" onClick={() => void send()} className="cp-send" disabled={visibleLoading || !visibleInput.trim()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" /></svg>
        </button>
      </div>
    </Card>
  );
}
