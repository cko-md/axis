import { Card } from "@/components/ui/Card";

const TXNS = [
  { ic: "🏦", title: "Salary — Hospital", meta: "Direct deposit · Jun 1", value: "+$3,400", up: true },
  { ic: "🍃", title: "HYSA transfer", meta: "Savings · Jun 2", value: "−$1,500", up: false },
  { ic: "📚", title: "UpToDate subscription", meta: "Education · Jun 3", value: "−$44", up: false },
  { ic: "🍽️", title: "Dinner — Lilia", meta: "Dining · Jun 5", value: "−$128", up: false },
  { ic: "📈", title: "Auto-invest — VTI", meta: "Brokerage · Jun 6", value: "−$1,000", up: false },
];

/** Phase-3 static stub — Recent Transactions list (prototype finance view). */
export function FundTransactions() {
  return (
    <Card tick>
      <h2 className="sec">
        Recent Transactions
        <span className="rule" />
        <span className="count">Plaid</span>
      </h2>
      <div style={{ marginTop: 10 }}>
        {TXNS.map((t) => (
          <div key={t.title} className="txn">
            <div className="txn-ic">{t.ic}</div>
            <div className="txn-b">
              <div className="txn-t">{t.title}</div>
              <div className="txn-m">{t.meta}</div>
            </div>
            <div className={`txn-v${t.up ? " up" : ""}`}>{t.value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
