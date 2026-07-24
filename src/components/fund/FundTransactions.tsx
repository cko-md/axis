"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

type PlaidTxn = {
  id: string;
  name: string;
  category: string;
  amountMinor: number;
  currency: string;
  date: string;
  pending: boolean;
};

const CATEGORY_IC: Record<string, string> = {
  FOOD_AND_DRINK: "🍽️",
  GROCERIES: "🛒",
  TRANSPORTATION: "🚗",
  MEDICAL: "🏥",
  ENTERTAINMENT: "🎬",
  SUBSCRIPTION: "📱",
  RENT_AND_UTILITIES: "🏠",
  TRAVEL: "✈️",
  GENERAL_MERCHANDISE: "🛍️",
  INCOME: "🏦",
};

function fmtAmount(amountMinor: number, currency: string) {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  });
  const abs = formatter.format(Math.abs(amountMinor) / 100);
  return amountMinor >= 0 ? `+${abs}` : `−${abs}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function FundTransactions() {
  const [txns, setTxns] = useState<PlaidTxn[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "no-plaid" | "no-account" | "error">(
    "loading",
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/plaid/transactions", { method: "POST" });
      const data = await res.json();
      if (!data.configured) { setStatus("no-plaid"); return; }
      if (data.error === "NO_LINKED_ACCOUNT") { setStatus("no-account"); return; }
      if (data.error) { setStatus("error"); return; }
      setTxns(data.transactions ?? []);
      setStatus("ok");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card tick>
      <h2 className="sec">
        Recent Transactions
        <span className="rule" />
        <span className="count">Plaid · 30d</span>
      </h2>
      <div style={{ marginTop: 10 }}>
        {status === "loading" && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading transactions…</p>
        )}
        {status === "no-plaid" && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
            Add PLAID_CLIENT_ID and PLAID_SECRET in Vercel to connect your bank.
          </p>
        )}
        {status === "no-account" && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
            No linked bank account — use Plaid Link to connect one.
          </p>
        )}
        {status === "error" && (
          <p style={{ fontSize: 12, color: "var(--clay)" }}>
            Could not load transactions. Try again later.
          </p>
        )}
        {status === "ok" && txns.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            No transactions in the last 30 days.
          </p>
        )}
        {status === "ok" &&
          txns.slice(0, 8).map((t) => (
            <div key={t.id} className="txn">
              <div className="txn-ic">{CATEGORY_IC[t.category] ?? "📋"}</div>
              <div className="txn-b">
                <div className="txn-t">
                  {t.name}
                  {t.pending && (
                    <span
                      style={{
                        marginLeft: 5,
                        fontSize: 9,
                        color: "var(--ink-faint)",
                        fontFamily: "var(--mono)",
                        letterSpacing: ".06em",
                      }}
                    >
                      PENDING
                    </span>
                  )}
                </div>
                <div className="txn-m">
                  {t.category.replace(/_/g, " ")} · {fmtDate(t.date)}
                </div>
              </div>
              <div className={`txn-v${t.amountMinor >= 0 ? " up" : ""}`}>
                {fmtAmount(t.amountMinor, t.currency)}
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}
