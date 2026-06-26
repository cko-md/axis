"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FundBudget } from "@/components/fund/FundBudget";
import { FundLiabilities } from "@/components/fund/FundLiabilities";
import { FundRecurringList } from "@/components/fund/FundRecurringList";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { fmtUsd } from "@/lib/store/fund-defaults";

type BankTxn = { amount: number; is_transfer: boolean; posted_date: string };
type Recurring = { expected_amount: number; status: string };
type Liability = { minimum_payment: number | null };

export function FundCashflowModule() {
  const { plaidConfigured, plaidLinked, cash, connectBank } = usePlaidConnection();
  const [income, setIncome] = useState(0);
  const [spend, setSpend] = useState(0);
  const [upcomingBills, setUpcomingBills] = useState(0);

  useEffect(() => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Promise.all([
      fetch(`/api/fund/bank-transactions?from=${since}&limit=500`).then((r) => r.json()),
      fetch("/api/fund/recurring").then((r) => r.json()),
      fetch("/api/fund/liabilities").then((r) => r.json()),
    ]).then(([txnData, recurringData, liabilityData]) => {
      const txns = (txnData.transactions ?? []) as BankTxn[];
      setIncome(txns.filter((t) => !t.is_transfer && t.amount > 0).reduce((s, t) => s + t.amount, 0));
      setSpend(txns.filter((t) => !t.is_transfer && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0));

      const recurring = ((recurringData.recurring ?? []) as Recurring[]).filter((r) => r.status === "active");
      const recurringMonthly = recurring.reduce((s, r) => s + Number(r.expected_amount), 0);
      const minPayments = ((liabilityData.liabilities ?? []) as Liability[]).reduce(
        (s, l) => s + Number(l.minimum_payment ?? 0),
        0,
      );
      setUpcomingBills(recurringMonthly + minPayments);
    }).catch(() => null);
  }, []);

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
