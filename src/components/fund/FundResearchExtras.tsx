"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";

export function FundResearchExtras() {
  const { toast } = useToast();
  const [report, setReport] = useState("");
  const [generating, setGenerating] = useState(false);

  const generateReport = async () => {
    setGenerating(true);
    setReport("");
    try {
      const res = await fetch("/api/fund/report", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401) {
          toast("Sign in to generate a market report.", "warn", "Market Report");
        } else {
          toast(err.error ?? "Report generation failed.", "error", "Market Report");
        }
        return;
      }
      const data = await res.json();
      setReport(data.report ?? "");
    } catch {
      toast("Network error — try again.", "error", "Market Report");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <Card tick>
        <h2 className="sec">
          Market Report
          <span className="rule" />
          <span className="count">AI · Polygon</span>
        </h2>
        <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.7, marginTop: 10 }}>
          Synthesized brief across your holdings and watchlist — earnings, macro, and news — sized
          to your risk rules. Runs server-side through Polygon (news, fundamentals) + Claude.
        </p>
        {report && (
          <div
            style={{
              marginTop: 12,
              padding: "12px 14px",
              background: "var(--glass)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              fontSize: 12.5,
              color: "var(--ink)",
              lineHeight: 1.7,
            }}
          >
            {report}
          </div>
        )}
        <button
          type="button"
          className="aibtn"
          style={{ marginTop: 14 }}
          disabled={generating}
          onClick={() => void generateReport()}
        >
          {generating ? "✦ Generating…" : "✦ Generate report"}
        </button>
      </Card>

      <div className="divider" />

      <Card>
        <h2 className="sec">
          Rules &amp; Alerts
          <span className="rule" />
          <span className="count">Templates</span>
        </h2>
        <div style={{ marginTop: 10 }}>
          <div className="metricrow">
            <span className="metric-k">Max single position</span>
            <span className="metric-v">10% target</span>
          </div>
          <div className="metricrow">
            <span className="metric-k">Rebalance band</span>
            <span className="metric-v">5% target</span>
          </div>
          <div className="metricrow">
            <span className="metric-k">Cash floor</span>
            <span className="metric-v">Not configured</span>
          </div>
        </div>
      </Card>
    </>
  );
}
