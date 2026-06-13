import { Card } from "@/components/ui/Card";

const INSIGHTS = [
  {
    ic: "↗",
    icColor: "var(--up)",
    title: "Dining is 22% above your 3-mo average",
    meta: "$640 vs $525 — trim 2 outings to free ~$180/mo",
    value: "+$180",
    up: true,
  },
  {
    ic: "↺",
    icColor: undefined,
    title: "3 overlapping subscriptions detected",
    meta: "UpToDate + 2 streaming — consolidate to save $31/mo",
    value: "+$31",
    up: true,
  },
  {
    ic: "🍃",
    icColor: undefined,
    title: "Idle cash above 9-mo runway",
    meta: "Move $6k to HYSA/T-bills — ~$260/yr at 4.3%",
    value: "+$260/yr",
    up: true,
  },
  {
    ic: "💳",
    icColor: undefined,
    title: "Venmo splits unreconciled",
    meta: "$214 owed to you across 4 friends — nudge to collect",
    value: "$214",
    up: false,
  },
];

const BUDGETS = [
  { label: "Dining", spent: "$640 / $525", pct: 100, cls: "over" },
  { label: "Subscriptions", spent: "$96 / $120", pct: 80, cls: "" },
  { label: "Groceries", spent: "$310 / $450", pct: 69, cls: "good" },
];

/** Phase-3 static stub — Budget Intelligence (prototype finance view). */
export function FundBudget() {
  return (
    <Card>
      <h2 className="sec">
        Budget Intelligence
        <span className="rule" />
        <span className="count">AI · Massive + Plaid</span>
      </h2>
      <div style={{ marginTop: 10 }}>
        {INSIGHTS.map((t) => (
          <div key={t.title} className="txn">
            <div className="txn-ic" style={t.icColor ? { color: t.icColor } : undefined}>
              {t.ic}
            </div>
            <div className="txn-b">
              <div className="txn-t">{t.title}</div>
              <div className="txn-m">{t.meta}</div>
            </div>
            <div className={`txn-v${t.up ? " up" : ""}`}>{t.value}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        {BUDGETS.map((b) => (
          <div key={b.label} className="budgetbar">
            <div className="bl">
              <span>{b.label}</span>
              <span className="bv">{b.spent}</span>
            </div>
            <div className="track">
              <div className={b.cls} style={{ width: `${b.pct}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
