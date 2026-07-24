"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FundBudget } from "@/components/fund/FundBudget";
import { FundLiabilities } from "@/components/fund/FundLiabilities";
import { FundRecurringList } from "@/components/fund/FundRecurringList";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { addMinorUnits, minorUnitsToDecimalString, strictMinorUnits } from "@/lib/fund/financialTruth";

type BankTxn = {
  amount: unknown;
  is_transfer: boolean;
  posted_date: string;
  iso_currency_code?: unknown;
  connection_id?: unknown;
  retrieved_at?: unknown;
};

function formatUsdMinor(value: number | null): string {
  if (value === null) return "—";
  const decimal = minorUnitsToDecimalString(value, "USD");
  if (!decimal) return "—";
  const negative = decimal.startsWith("-");
  const [whole, fraction] = (negative ? decimal.slice(1) : decimal).split(".");
  return `${negative ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function transactionTotals(rows: readonly BankTxn[]): { incomeMinor: number; spendMinor: number } | null {
  let incomeMinor = 0;
  let spendMinor = 0;
  for (const row of rows) {
    if (
      row.iso_currency_code !== "USD" ||
      typeof row.connection_id !== "string" ||
      !row.connection_id ||
      typeof row.retrieved_at !== "string" ||
      !row.retrieved_at
    ) return null;
    const amountMinor = strictMinorUnits(row.amount, "USD");
    if (amountMinor === null) return null;
    const next = amountMinor >= 0
      ? addMinorUnits(incomeMinor, amountMinor)
      : addMinorUnits(spendMinor, -amountMinor);
    if (next === null) return null;
    if (amountMinor >= 0) incomeMinor = next;
    else spendMinor = next;
  }
  return { incomeMinor, spendMinor };
}

async function loadCompleteTransactions(since: string): Promise<BankTxn[]> {
  const rows: BankTxn[] = [];
  const pageSize = 500;
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const response = await fetch(
      `/api/fund/bank-transactions?from=${since}&limit=${pageSize}&offset=${offset}`,
    );
    if (!response.ok) throw new Error("transactions");
    const body = await response.json() as {
      transactions?: BankTxn[];
      completeness?: string;
      page?: { hasMore?: boolean };
    };
    if (body.completeness !== "complete_source_page" || !Array.isArray(body.transactions)) {
      throw new Error("transaction coverage");
    }
    rows.push(...body.transactions);
    if (!body.page?.hasMore) return rows;
  }
  throw new Error("transaction row limit");
}

export function FundCashflowModule() {
  const {
    plaidConfigured,
    plaidLinked,
    plaidReconnectRequired,
    plaidStatusState,
    cashMinor,
    connectBank,
    recoverBankConnection,
    balanceError,
  } = usePlaidConnection();
  const [incomeMinor, setIncomeMinor] = useState<number | null>(null);
  const [spendMinor, setSpendMinor] = useState<number | null>(null);
  const [cashflowNotice, setCashflowNotice] = useState<string | null>(null);

  useEffect(() => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Promise.allSettled([
      loadCompleteTransactions(since),
      fetch("/api/fund/recurring").then((r) => {
        if (!r.ok) throw new Error("recurring");
        return r.json();
      }),
    ]).then(([txnResult, recurringResult]) => {
      const failed = [
        txnResult.status === "rejected" ? "transactions" : null,
        recurringResult.status === "rejected" ? "recurring" : null,
      ].filter((item): item is string => !!item);

      const txns = txnResult.status === "fulfilled"
        ? txnResult.value.filter((transaction) => !transaction.is_transfer)
        : null;
      const totals = txns ? transactionTotals(txns) : null;
      setIncomeMinor(totals?.incomeMinor ?? null);
      setSpendMinor(totals?.spendMinor ?? null);
      if (txnResult.status === "fulfilled" && !totals) failed.push("transaction coverage");

      setCashflowNotice(failed.length ? `Partial refresh — ${failed.join(", ")} unavailable.` : null);
    }).catch(() => setCashflowNotice("Cash flow could not refresh."));
  }, []);

  // This view combines manual recurring/minimum-payment entries with live
  // cash, so it is not an authoritative investment-capacity calculation.
  const runwayMonths = cashMinor !== null && spendMinor !== null && spendMinor > 0
    ? cashMinor / spendMinor
    : null;

  return (
    <div>
      {plaidStatusState === "unavailable" ? (
        <Card style={{ marginBottom: 16 }}>
          <div className="empty-state">
            <strong>Plaid connection status unavailable</strong>
            <p>Cash flow cannot determine whether a bank is linked. Try again after the connection status refreshes.</p>
          </div>
        </Card>
      ) : plaidStatusState === "loading" ? (
        <Card style={{ marginBottom: 16 }}>
          <div className="empty-state"><strong>Checking bank connection…</strong></div>
        </Card>
      ) : !plaidLinked && !plaidReconnectRequired && (
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
      {plaidReconnectRequired && (
        <Card style={{ marginBottom: 16 }}>
          <div className="empty-state">
            <strong>Plaid authorization must be replaced</strong>
            <p>Disconnect the unverified authorization before creating a fresh link.</p>
            <button type="button" className="feed-manage" onClick={recoverBankConnection}>
              Disconnect and relink Plaid
            </button>
          </div>
        </Card>
      )}

      <div className="ftop">
        <Card tick>
          <div className="seclabel">Income · 30d</div>
          <div className="bigmetric">{formatUsdMinor(incomeMinor)}</div>
        </Card>
        <Card>
          <div className="seclabel">Spend · 30d</div>
          <div className="bigmetric">{formatUsdMinor(spendMinor)}</div>
        </Card>
        <Card>
          <div className="seclabel">Safe to invest</div>
          <div className="bigmetric up">—</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 4 }}>
            Unavailable pending complete provider coverage
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
