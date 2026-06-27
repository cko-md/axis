"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

type Recurring = {
  id: string;
  merchant_name: string;
  expected_amount: number;
  cadence: string;
  next_expected_date: string | null;
  status: string;
};

export function FundRecurringList() {
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/fund/recurring");
    const data = await res.json().catch(() => ({}));
    setRecurring((data.recurring ?? []).filter((r: Recurring) => r.status === "active"));
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(id: string, status: "cancelled" | "active") {
    await fetch(`/api/fund/recurring/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setRecurring((prev) => prev.filter((r) => r.id !== id));
  }

  const monthlyTotal = recurring.reduce((s, r) => s + Number(r.expected_amount), 0);

  return (
    <Card tick>
      <h2 className="sec">Recurring<span className="rule" /><span className="count">${monthlyTotal.toFixed(0)}/mo</span></h2>
      <div style={{ marginTop: 10 }}>
        {!loaded && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>}
        {loaded && recurring.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
            No recurring charges detected yet — the finance-daily job finds these once you have a few months of synced transactions.
          </p>
        )}
        {recurring.map((r) => (
          <div key={r.id} className="metricrow" style={{ marginTop: 8 }}>
            <span className="metric-k">
              {r.merchant_name} · {r.cadence}
              {r.next_expected_date ? ` · next ${r.next_expected_date}` : ""}
            </span>
            <span className="metric-v">
              ${r.expected_amount.toFixed(2)}
              <button type="button" onClick={() => setStatus(r.id, "cancelled")} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 10 }}>
                dismiss
              </button>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
