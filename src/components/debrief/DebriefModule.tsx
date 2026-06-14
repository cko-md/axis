"use client";

export function DebriefModule() {
  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Plan</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Debrief</h1>
      <div className="divider" />
      <div className="crm-toolbar">
        <button type="button" className="sig-go">+ Add Entry</button>
        <button type="button" className="feed-manage">✦ Auto-fill from this week</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, alignItems: "start" }}>
        <div className="card tick">
          <h2 className="sec">Wins<span className="rule" /></h2>
          <div style={{ marginTop: 12 }}>
            <div className="task">
              <div className="check done" />
              <div className="task-main">
                <div className="task-title" style={{ textDecoration: "line-through", color: "var(--ink-faint)" }}>AANS abstract submitted</div>
              </div>
            </div>
            <div className="task">
              <div className="check done" />
              <div className="task-main">
                <div className="task-title" style={{ textDecoration: "line-through", color: "var(--ink-faint)" }}>Cohort 2 chart review (80%)</div>
              </div>
            </div>
            <div className="task">
              <div className="check done" />
              <div className="task-main">
                <div className="task-title" style={{ textDecoration: "line-through", color: "var(--ink-faint)" }}>4 zone-2 runs · 38 km</div>
              </div>
            </div>
          </div>
        </div>
        <div className="card">
          <h2 className="sec">Friction<span className="rule" /></h2>
          <div style={{ marginTop: 12 }}>
            <div className="task">
              <div className="check" />
              <div className="task-main">
                <div className="task-title">Data-use agreement signature</div>
                <div className="task-meta"><span className="pill hi">2 weeks idle</span></div>
              </div>
            </div>
            <div className="task">
              <div className="check" />
              <div className="task-main">
                <div className="task-title">IRB amendment — UIA cohort</div>
                <div className="task-meta"><span className="pill med">blocked on PI</span></div>
              </div>
            </div>
          </div>
        </div>
        <div className="card">
          <h2 className="sec">Metrics<span className="rule" /></h2>
          <div style={{ marginTop: 12 }}>
            <div className="metricrow"><span className="metric-k">Deep-work hours</span><span className="metric-v">22.5h</span></div>
            <div className="metricrow"><span className="metric-k">Tasks completed</span><span className="metric-v up">19</span></div>
            <div className="metricrow"><span className="metric-k">Run volume</span><span className="metric-v">38 km</span></div>
            <div className="metricrow"><span className="metric-k">Savings rate</span><span className="metric-v up">28%</span></div>
            <div className="metricrow"><span className="metric-k">French lessons</span><span className="metric-v">4 / 5</span></div>
          </div>
        </div>
      </div>
      <div className="divider" />
      <div className="card" style={{ maxWidth: "min(720px,92vw)" }}>
        <div className="seclabel">Reflection</div>
        <p style={{ color: "var(--ink-dim)", fontFamily: "var(--serif)", fontSize: 17, lineHeight: 1.5 }}>
          What moved the needle this week, and what will you say no to next week to protect the manuscript?
        </p>
        <textarea
          placeholder="Write your reflection…"
          rows={5}
          style={{
            width: "100%",
            marginTop: 14,
            padding: "11px 14px",
            background: "var(--glass)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r)",
            color: "var(--ink)",
            fontFamily: "var(--serif)",
            fontSize: 15,
            lineHeight: 1.7,
            resize: "vertical",
            outline: "none",
            transition: "border-color .15s",
          }}
          onFocus={(e) => (e.target.style.borderColor = "var(--line-strong)")}
          onBlur={(e) => (e.target.style.borderColor = "var(--line)")}
        />
      </div>
    </>
  );
}
