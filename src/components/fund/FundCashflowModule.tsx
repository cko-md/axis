"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FundBudget } from "@/components/fund/FundBudget";
import { FundLiabilities } from "@/components/fund/FundLiabilities";
import { FundRecurringList } from "@/components/fund/FundRecurringList";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { useFundData } from "@/components/fund/FundDataProvider";
import { fmtUsd } from "@/lib/store/fund-defaults";

type BankTxn = { amount: number; is_transfer: boolean; posted_date: string };
type Recurring = { expected_amount: number; status: string };

export function FundCashflowModule() {
  const { plaidConfigured, plaidLinked, cash, connectBank, balanceError } = usePlaidConnection();
  // FUND-1: liabilities' minimum payments come from the shared layout store,
  // not a third fetch batched here (the same data Net Worth/Overview use).
  const { liabilities } = useFundData();
  const [income, setIncome] = useState(0);
  const [spend, setSpend] = useState(0);
  const [recurringMonthly, setRecurringMonthly] = useState(0);
  const [cashflowNotice, setCashflowNotice] = useState<string | null>(null);

  useEffect(() => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Promise.allSettled([
      fetch(`/api/fund/bank-transactions?from=${since}&limit=500`).then((r) => {
        if (!r.ok) throw new Error("transactions");
        return r.json();
      }),
      fetch("/api/fund/recurring").then((r) => {
        if (!r.ok) throw new Error("recurring");
        return r.json();
      }),
    ]).then(([txnResult, recurringResult]) => {
      const failed = [
        txnResult.status === "rejected" ? "transactions" : null,
        recurringResult.status === "rejected" ? "recurring" : null,
      ].filter((item): item is string => !!item);

      const txnData = txnResult.status === "fulfilled" ? txnResult.value : {};
      const recurringData = recurringResult.status === "fulfilled" ? recurringResult.value : {};
      const txns = (txnData.transactions ?? []) as BankTxn[];
      setIncome(txns.filter((t) => !t.is_transfer && t.amount > 0).reduce((s, t) => s + t.amount, 0));
      setSpend(txns.filter((t) => !t.is_transfer && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0));

      const recurring = ((recurringData.recurring ?? []) as Recurring[]).filter((r) => r.status === "active");
      setRecurringMonthly(recurring.reduce((s, r) => s + Number(r.expected_amount), 0));
      setCashflowNotice(failed.length ? `Partial refresh — ${failed.join(", ")} unavailable.` : null);
    }).catch(() => setCashflowNotice("Cash flow could not refresh."));
  }, []);

  const minPayments = liabilities.reduce((s, l) => s + Number(l.minimum_payment ?? 0), 0);
  const upcomingBills = recurringMonthly + minPayments;
  const safeToInvest = Math.max(cash - upcomingBills, 0);
  const runwayMonths = spend > 0 ? cash / spend : null;

  return (
    <div>
      {!plaidLinked && (
        <Card style={{ marginBottom: 16 }}>
          <div className="empty-state">
            <strong>Connect a bank to see cash flow</strong>
            <p>
              Income, spend, and runway populate from your linked accounts via Plaid.{" "}
              {plaidConfigured ? "Link an account to begin." : "Add PLAID_CLIENT_ID and PLAID_SECRET, then link a bank."}
            </p>
            <button type="button" className="feed-manage" style={{ marginTop: 12 }} onClick={connectBank}>
              {plaidConfigured ? "Link a bank" : "Connect bank · Plaid"}
            </button>
          </div>
        </Card>
      )}

      <div className="ftop">
        <Card tick>
          <div className="seclabel">Income · 30d</div>
          <div className="bigmetric">{fmtUsd(income)}</div>
        </Card>
        <Card>
          <div className="seclabel">Spend · 30d</div>
          <div className="bigmetric">{fmtUsd(spend)}</div>
        </Card>
        <Card>
          <div className="seclabel">Safe to invest</div>
          <div className="bigmetric up">{fmtUsd(safeToInvest)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 4 }}>
            Cash minus upcoming bills/min. payments
          </div>
        </Card>
        <Card>
          <div className="seclabel">Runway</div>
          <div className="bigmetric">{runwayMonths != null ? `${runwayMonths.toFixed(1)} mo` : "—"}</div>
        </Card>
      </div>
      {balanceError && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--clay)" }}>
          Bank balances could not refresh — showing saved cash flow data.
        </p>
      )}
      {cashflowNotice && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--clay)" }}>{cashflowNotice}</p>
      )}

      <div className="divider" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <FundLiabilities />
        <FundRecurringList />
      </div>
      <div className="divider" />
      <FundBudget />
    </div>
  );
}
