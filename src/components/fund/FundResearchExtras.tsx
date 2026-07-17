"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import type { MarketReportSource } from "@/lib/fund/marketReport";

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
  const [reports, setReports] = useState<ResearchInsight[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadReports() {
      try {
        const res = await fetch("/api/fund/insights?kind=market_report");
        if (res.status === 401) {
          if (active) setHistoryStatus("signed-out");
          return;
        }
        if (!res.ok) throw new Error("market_report_history_unavailable");
        const data = await res.json() as { insights?: ResearchInsight[] };
        if (!active) return;
        const next = data.insights ?? [];
        setReports(next);
        setSelectedId(next[0]?.id ?? null);
        setHistoryStatus("ready");
      } catch {
        if (active) setHistoryStatus("error");
      }
    }
    void loadReports();
    return () => { active = false; };
  }, []);

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedId) ?? reports[0] ?? null,
    [reports, selectedId],
  );
  const sources = selectedReport?.data_used?.sources ?? [];

  async function generateReport() {
    setGenerating(true);
    try {
      const res = await fetch("/api/fund/report", { method: "POST" });
      const data = await res.json().catch(() => ({}));
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
      toast("Market report saved to research history.", "success", "Market Report");
    } catch {
      toast("Network error while generating the report.", "error", "Market Report");
    } finally {
      setGenerating(false);
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
          <button type="button" className="aibtn" disabled={generating} onClick={() => void generateReport()}>
            {generating ? "Generating..." : "Generate report"}
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.7, marginTop: 10 }}>
          A saved research draft from your holdings, watchlist, and available market-source metadata. Review it before acting.
        </p>

        {historyStatus === "loading" && <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 14 }}>Loading research history...</p>}
        {historyStatus === "signed-out" && <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 14 }}>Sign in to save and revisit market research.</p>}
        {historyStatus === "error" && <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 14 }}>Saved research could not load. You can still generate a new report after signing in.</p>}
        {historyStatus === "ready" && reports.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 14 }}>No saved reports yet. Generate one when you want a compact review prompt.</p>
        )}

        {reports.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 14 }} aria-label="Saved market reports">
            {reports.map((report) => (
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
