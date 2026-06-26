import { Card } from "@/components/ui/Card";

export default function FundForecastingPage() {
  return (
    <Card tick>
      <h2 className="sec">Forecasting<span className="rule" /><span className="count">V1</span></h2>
      <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.7, marginTop: 10 }}>
        Deterministic projection, sensitivity table, and scenario comparison (increase investments,
        decrease spending, market drawdown, higher income, large purchase, debt payoff vs invest)
        land in V1, once Net Worth and Cash Flow have enough real history to project from.
      </p>
    </Card>
  );
}
