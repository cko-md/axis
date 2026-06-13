import { Card } from "@/components/ui/Card";

/** Phase-3 static stub — Market Report + Rules & Alerts (prototype finance view). */
export function FundResearchExtras() {
  return (
    <>
      <Card tick>
        <h2 className="sec">
          Market Report
          <span className="rule" />
          <span className="count">Massive · AI</span>
        </h2>
        <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.7, marginTop: 10 }}>
          Generate a synthesized brief across your holdings and watchlist — earnings, macro, and
          news — sized to your risk rules. Runs server-side through Massive (aggregates, news,
          fundamentals) + the AI gateway; cached and rate-limited.
        </p>
        <button type="button" className="aibtn" style={{ marginTop: 14 }} onClick={() => {}}>
          ✦ Generate report
        </button>
      </Card>

      <div className="divider" />

      <Card>
        <h2 className="sec">
          Rules &amp; Alerts
          <span className="rule" />
        </h2>
        <div style={{ marginTop: 10 }}>
          <div className="metricrow">
            <span className="metric-k">Max single position</span>
            <span className="metric-v">10% · NVDA over</span>
          </div>
          <div className="metricrow">
            <span className="metric-k">Rebalance band</span>
            <span className="metric-v">±5%</span>
          </div>
          <div className="metricrow">
            <span className="metric-k">Cash floor</span>
            <span className="metric-v up">Met</span>
          </div>
        </div>
      </Card>
    </>
  );
}
