"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { addMinorUnits, minorUnitsToDecimalString, scaledUnitsToDecimalString, strictMinorUnits, strictScaledUnits } from "@/lib/fund/financialTruth";
import { MICRO_SHARES_PER_SHARE } from "@/lib/fund/taxLots";
import { Card } from "@/components/ui/Card";
import { NetWorthChart } from "@/components/fund/NetWorthChart";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";

type Insight = { id: string; title: string; body: string; confidence: string };
type OverviewHolding = { id?: string; symbol: string; name: string; shares: string; costBasisMinor: number };

function formatUsdMinor(value: number | null): string {
  if (value === null) return "—";
  const decimal = minorUnitsToDecimalString(value, "USD");
  if (!decimal) return "—";
  const negative = decimal.startsWith("-");
  const [whole, fraction] = (negative ? decimal.slice(1) : decimal).split(".");
  return `${negative ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function formatExactUsd(value: string | null): string {
  if (value === null) return "—";
  const match = value.match(/^(-?)(\d+)\.(\d{2})$/);
  return match
    ? `${match[1]}$${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${match[3]}`
    : "—";
}

export function OverviewModule() {
  const {
    plaidConfigured,
    plaidLinked,
    plaidReconnectRequired,
    plaidStatusState,
    brokerageStatusState,
    bankAccounts,
    cash,
    cashReason,
    connectBank,
    recoverBankConnection,
    brokerageConfigured,
    balanceError,
  } =
    usePlaidConnection();
  // FUND-1: liabilities come from the shared layout store (the same
  // /api/fund/liabilities data Net Worth + Cashflow use), not a separate fetch.
  const [signedIn, setSignedIn] = useState(false);
  const [holdings, setHoldings] = useState<OverviewHolding[]>([]);
  const [investedCostBasisMinor, setInvestedCostBasisMinor] = useState<number | null>(null);
  const [holdingsState, setHoldingsState] = useState<"loading" | "empty" | "ready" | "unavailable">("loading");
  const [brief, setBrief] = useState<Insight | null>(null);

  const loadHoldings = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setSignedIn(true);
    const { data, error } = await supabase
      .from("fund_holdings")
      .select("id, symbol, name, shares, cost_basis, currency")
      .eq("user_id", user.id)
      .order("sort_order");
    if (error || !data) {
      setInvestedCostBasisMinor(null);
      setHoldingsState("unavailable");
      return;
    }
    if (data.length === 0) {
      setHoldings([]);
      setInvestedCostBasisMinor(0);
      setHoldingsState("empty");
      return;
    }
    let totalMinor = 0;
    const parsed: OverviewHolding[] = [];
    for (const row of data) {
      const sharesMicro = strictScaledUnits(row.shares, MICRO_SHARES_PER_SHARE);
      const basisMinor = row.currency === "USD" ? strictMinorUnits(row.cost_basis, "USD") : null;
      const nextTotal = basisMinor === null ? null : addMinorUnits(totalMinor, basisMinor);
      const shares = sharesMicro === null ? null : scaledUnitsToDecimalString(sharesMicro, MICRO_SHARES_PER_SHARE);
      if (shares === null || basisMinor === null || nextTotal === null) {
        setHoldings([]);
        setInvestedCostBasisMinor(null);
        setHoldingsState("unavailable");
        return;
      }
      totalMinor = nextTotal;
      parsed.push({
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        shares,
        costBasisMinor: basisMinor,
      });
    }
    setHoldings(parsed);
    setInvestedCostBasisMinor(totalMinor);
    setHoldingsState("ready");
  }, []);

  useEffect(() => {
    void loadHoldings();
    fetch("/api/fund/insights?kind=daily_brief")
      .then((r) => r.json())
      .then((d: { insights?: Insight[] }) => setBrief(d.insights?.[0] ?? null))
      .catch(() => null);
  }, [loadHoldings]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button type="button" className="selectbox" style={{ background: "none" }} onClick={connectBank} title="Connect a bank with Plaid">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 7h18v12H3zM3 11h18" />
          </svg>
          {plaidStatusState === "loading" ? "Plaid …" : plaidStatusState === "unavailable" ? "Plaid unavailable" : plaidConfigured ? "Plaid ✓" : "Connect Plaid"}
        </button>
        <span className="selectbox" title="Public brokerage status">
          {brokerageStatusState === "loading" ? "Public …" : brokerageStatusState === "unavailable" ? "Public unavailable" : brokerageConfigured ? "Public ✓" : "Public not connected"}
        </span>
      </div>

      <div className="fund-hero">
        <Card tick>
          <div className="seclabel">Net Worth</div>
          <div className="bigmetric" style={{ fontSize: 30 }}>—</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
            Live net worth requires complete provider coverage
          </div>
          <NetWorthChart signedIn={signedIn} />
        </Card>
        <Card>
          <div className="seclabel">Invested cost basis</div>
          <div className="bigmetric">{formatUsdMinor(investedCostBasisMinor)}</div>
          {holdingsState === "unavailable" && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--clay)", marginTop: 4 }}>
              Cost basis unavailable: incomplete or mixed-currency coverage
            </div>
          )}
        </Card>
        <Card>
          <div className="seclabel">Cash</div>
          <div className="bigmetric">{formatExactUsd(cash)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
            {bankAccounts.length
              ? `${bankAccounts.length} account${bankAccounts.length === 1 ? "" : "s"} · Plaid`
              : plaidStatusState === "unavailable"
                ? "Plaid connection status unavailable"
                : plaidStatusState === "loading"
                  ? "Checking Plaid connection…"
                  : plaidLinked
                ? "Plaid connected"
                : signedIn
                  ? "No bank linked"
                : "Sign in to connect"}
          </div>
          {balanceError && !cashReason && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--clay)", marginTop: 4 }}>
              Balance refresh failed
            </div>
          )}
          {cashReason && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--clay)", marginTop: 4 }}>
              Cash unavailable: {cashReason}
            </div>
          )}
          {plaidReconnectRequired && (
            <>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--clay)", marginTop: 4 }}>
                This Plaid authorization is unverified. Disconnect it before creating a fresh link.
              </div>
              <button type="button" className="feed-manage" style={{ marginTop: 10 }} onClick={recoverBankConnection}>
                Disconnect and relink Plaid
              </button>
            </>
          )}
          {bankAccounts.filter((account) => account.type === "depository").length ? (
            bankAccounts.filter((account) => account.type === "depository").map((a) => (
              <div key={a.name + (a.mask ?? "")} className="metricrow" style={{ marginTop: 8 }}>
                <span className="metric-k">{a.name}{a.mask ? ` ··${a.mask}` : ""}</span>
                <span className="metric-v">{formatExactUsd(a.current)}</span>
              </div>
            ))
          ) : signedIn && plaidStatusState === "ready" && !plaidReconnectRequired ? (
            <button type="button" className="feed-manage" style={{ marginTop: 14 }} onClick={connectBank}>
              {plaidConfigured ? "Link a bank" : "Connect bank · Plaid"}
            </button>
          ) : null}
          {bankAccounts.some((account) => account.type !== "depository") && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", marginTop: 8 }}>
              Non-depository accounts are excluded from Cash until their provider components are reconciled.
            </div>
          )}
        </Card>
      </div>

      <div className="divider" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card tick>
          <h2 className="sec">Holdings<span className="rule" /><span className="count">Cost basis · live movers unavailable</span></h2>
          {holdingsState === "loading" ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>Loading holdings…</p>
          ) : holdingsState === "unavailable" ? (
            <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 10 }}>Holdings unavailable: incomplete or mixed-currency coverage.</p>
          ) : holdingsState === "empty" ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>No holdings yet — add some on the Investing page.</p>
          ) : (
            <table className="holdings" style={{ marginTop: 8 }}>
              <tbody>
                {holdings.slice(0, 4).map((h) => (
                    <tr key={h.symbol}>
                      <td>{h.symbol}</td>
                      <td>{h.name}</td>
                      <td>{formatUsdMinor(h.costBasisMinor)}</td>
                      <td style={{ color: "var(--ink-faint)" }}>Cost basis</td>
                    </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <h2 className="sec">Daily Brief<span className="rule" /><span className="count">{brief ? brief.confidence : "—"}</span></h2>
          <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.65, marginTop: 10 }}>
            {brief ? brief.body : "No brief yet — the finance-daily job writes one once net-worth history accrues."}
          </p>
        </Card>
      </div>
    </div>
  );
}
