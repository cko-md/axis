"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

type Insight = {
  ic: string;
  icColor?: string;
  title: string;
  meta: string;
  value: string;
  up: boolean;
};

type Budget = {
  label: string;
  spent: string;
  pct: number;
  cls: string;
};

export function FundBudget() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "no-plaid" | "no-account" | "error">(
    "loading",
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/plaid/budget", { method: "POST" });
      const data = await res.json();
      if (!data.configured) { setStatus("no-plaid"); return; }
      if (data.error === "NO_LINKED_ACCOUNT") { setStatus("no-account"); return; }
      if (data.error) { setStatus("error"); return; }
      setInsights(data.insights ?? []);
      setBudgets(data.budgets ?? []);
      setStatus("ok");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card>
      <h2 className="sec">
        Budget Intelligence
        <span className="rule" />
        <span className="count">Plaid · This month</span>
      </h2>

      {status === "loading" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)" }}>
          Analyzing spending…
        </p>
      )}
      {status === "no-plaid" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
          Add PLAID_CLIENT_ID and PLAID_SECRET in Vercel to see live budget intelligence.
        </p>
      )}
      {status === "no-account" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
          Link a bank account to see budget insights.
        </p>
      )}
      {status === "error" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--clay)" }}>
          Could not load budget data. Try again later.
        </p>
      )}

      {status === "ok" && (
        <>
          <div style={{ marginTop: 10 }}>
            {insights.map((t) => (
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
          {budgets.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {budgets.map((b) => (
                <div key={b.label} className="budgetbar">
                  <div className="bl">
                    <span>{b.label}</span>
                    <span className="bv">{b.spent}</span>
                  </div>
                  <div className="track">
                    <div className={b.cls} style={{ width: `${Math.min(b.pct, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
