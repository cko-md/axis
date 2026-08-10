"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import type { MarketReportSource } from "@/lib/fund/marketReport";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type ResearchInsight = {
  id: string;
  title: string;
  body: string;
  created_at: string;
  data_used: { sources?: MarketReportSource[]; source_status?: string; model?: string } | null;
};

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function FundResearchExtras() {
  const { toast } = useToast();
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const generationRef = useRef(0);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [reports, setReports] = useState<ResearchInsight[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [generating, setGenerating] = useState(false);
  const [researchIdentity, setResearchIdentity] = useState<string | null>(null);

  useEffect(() => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setReports([]);
    setSelectedId(null);
    setHistoryStatus("loading");
    setGenerating(false);
    setResearchIdentity(null);
    if (!expectedSubject) {
      setHistoryStatus("signed-out");
      return () => controller.abort();
    }
    const subject = expectedSubject;
    const isCurrent = () => !controller.signal.aborted
      && generationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    async function loadReports() {
      try {
        const res = await subjectBoundFetch(subject, "/api/fund/insights?kind=market_report", { signal: controller.signal });
        if (!isCurrent()) return;
        if (res.status === 401) {
          if (isCurrent()) {
            setResearchIdentity(`${expectedSubject}:${expectedEpoch}`);
            setHistoryStatus("signed-out");
          }
          return;
        }
        if (!res.ok) throw new Error("market_report_history_unavailable");
        const data = await res.json() as { insights?: ResearchInsight[] };
        if (!isCurrent()) return;
        const next = data.insights ?? [];
        setReports(next);
        setSelectedId(next[0]?.id ?? null);
        setHistoryStatus("ready");
        setResearchIdentity(`${expectedSubject}:${expectedEpoch}`);
      } catch {
        if (isCurrent()) {
          setResearchIdentity(`${expectedSubject}:${expectedEpoch}`);
          setHistoryStatus("error");
        }
      }
    }
    void loadReports();
    return () => controller.abort();
  }, [authorityEpoch, currentSubject]);

  const ownsResearch = researchIdentity === currentIdentity;
  const visibleReports = ownsResearch ? reports : [];
  const visibleSelectedId = ownsResearch ? selectedId : null;
  const visibleHistoryStatus = ownsResearch ? historyStatus : currentSubject ? "loading" : "signed-out";
  const visibleGenerating = ownsResearch && generating;

  const selectedReport = useMemo(
    () => visibleReports.find((report) => report.id === visibleSelectedId) ?? visibleReports[0] ?? null,
    [visibleReports, visibleSelectedId],
  );
  const sources = selectedReport?.data_used?.sources ?? [];

  async function generateReport() {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) return;
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    setGenerating(true);
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/fund/report", { method: "POST" });
      if (!isCurrent()) return;
      const data = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!res.ok) {
        if (res.status === 401) toast("Sign in to generate a market report.", "warn", "Market Report");
        else if (data.error === "REPORT_PERSISTENCE_FAILED") toast("Report could not be saved. Please try again.", "error", "Market Report");
        else toast("Market report is unavailable right now.", "error", "Market Report");
        return;
      }
      const insight = data.insight as ResearchInsight | undefined;
      if (!insight) throw new Error("missing_market_report");
      setReports((previous) => [insight, ...previous.filter((report) => report.id !== insight.id)].slice(0, 10));
      setSelectedId(insight.id);
      setHistoryStatus("ready");
      setResearchIdentity(`${expectedSubject}:${expectedEpoch}`);
      toast("Market report saved to research history.", "success", "Market Report");
    } catch {
      if (isCurrent()) toast("Network error while generating the report.", "error", "Market Report");
    } finally {
      if (isCurrent()) setGenerating(false);
    }
  }

  return (
    <>
      <Card tick>
        <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
          <h2 className="sec" style={{ margin: 0 }}>
            Market Research
            <span className="rule" />
            <span className="count">AI draft · cited</span>
          </h2>
          <button type="button" className="aibtn" disabled={visibleGenerating} onClick={() => void generateReport()}>
            {visibleGenerating ? "Generating..." : "Generate report"}
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.7, marginTop: 10 }}>
          A saved research draft from your holdings, watchlist, and available market-source metadata. Review it before acting.
        </p>

        {visibleHistoryStatus === "loading" && <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 14 }}>Loading research history...</p>}
        {visibleHistoryStatus === "signed-out" && <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 14 }}>Sign in to save and revisit market research.</p>}
        {visibleHistoryStatus === "error" && <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 14 }}>Saved research could not load. You can still generate a new report after signing in.</p>}
        {visibleHistoryStatus === "ready" && visibleReports.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 14 }}>No saved reports yet. Generate one when you want a compact review prompt.</p>
        )}

        {visibleReports.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 14 }} aria-label="Saved market reports">
            {visibleReports.map((report) => (
              <button
                key={report.id}
                type="button"
                onClick={() => setSelectedId(report.id)}
                aria-pressed={selectedReport?.id === report.id}
                style={{ border: "1px solid var(--line)", borderRadius: 5, padding: "5px 8px", background: selectedReport?.id === report.id ? "var(--surface-2)" : "transparent", color: "var(--ink-dim)", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10 }}
              >
                {formatTimestamp(report.created_at)}
              </button>
            ))}
          </div>
        )}

        {selectedReport && (
          <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>{formatTimestamp(selectedReport.created_at)}</div>
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ink)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{selectedReport.body}</p>
            {selectedReport.data_used?.source_status === "unavailable" && (
              <p style={{ fontSize: 11, color: "var(--clay)", marginTop: 12 }}>Market sources were unavailable for this report; it uses only your saved portfolio context.</p>
            )}
            {selectedReport.data_used?.source_status === "not_configured" && (
              <p style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 12 }}>Market sources were not configured for this report.</p>
            )}
          </div>
        )}
      </Card>

      {selectedReport && (
        <>
          <div className="divider" />
          <Card>
            <h2 className="sec">Sources<span className="rule" /><span className="count">{sources.length}</span></h2>
            {sources.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>No market-source links were available for this saved report.</p>
            ) : (
              <div style={{ marginTop: 8 }}>
                {sources.map((source) => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer" style={{ display: "block", color: "var(--ink)", padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
                    {source.title}
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 3 }}>
                      {[source.publisher, source.tickers.join(", "), formatTimestamp(source.publishedAt)].filter(Boolean).join(" · ")}
                    </div>
                  </a>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
