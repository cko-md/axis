"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtUsd, holdingGain, holdingValue, type HoldingRow } from "@/lib/store/fund-defaults";
import { Card } from "@/components/ui/Card";
import { NetWorthChart } from "@/components/fund/NetWorthChart";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";

type Insight = { id: string; title: string; body: string; confidence: string };

export function OverviewModule() {
  const { plaidConfigured, plaidLinked, bankAccounts, cash, connectBank, brokerageConfigured } =
    usePlaidConnection();
  const [signedIn, setSignedIn] = useState(false);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [liabilities, setLiabilities] = useState(0);
  const [brief, setBrief] = useState<Insight | null>(null);

  const loadHoldings = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setSignedIn(true);
    const { data } = await supabase
      .from("fund_holdings")
      .select("id, symbol, name, shares, cost_basis")
      .eq("user_id", user.id)
      .order("sort_order");
    if (data) {
      setHoldings(data.map((r) => ({ id: r.id, symbol: r.symbol, name: r.name, shares: Number(r.shares), cost_basis: Number(r.cost_basis) })));
    }
  }, []);

  useEffect(() => {
    void loadHoldings();
    fetch("/api/fund/liabilities")
      .then((r) => r.json())
      .then((d: { liabilities?: Array<{ balance: number }> }) =>
        setLiabilities((d.liabilities ?? []).reduce((s, l) => s + Number(l.balance), 0)),
      )
      .catch(() => null);
    fetch("/api/fund/insights?kind=daily_brief")
      .then((r) => r.json())
      .then((d: { insights?: Insight[] }) => setBrief(d.insights?.[0] ?? null))
      .catch(() => null);
  }, [loadHoldings]);

  const invested = holdings.reduce((s, h) => s + holdingValue(h), 0);
  const netWorth = invested + cash - liabilities;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button type="button" className="selectbox" style={{ background: "none" }} onClick={connectBank} title="Connect a brokerage or bank">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 7h18v12H3zM3 11h18" />
          </svg>
          {brokerageConfigured ? "Public ✓" : "Public"} · {plaidConfigured ? "Plaid ✓" : "Plaid"}
        </button>
      </div>

      <div className="fund-hero">
        <Card tick>
          <div className="seclabel">Net Worth</div>
          <div className="bigmetric" style={{ fontSize: 30 }}>{fmtUsd(netWorth)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--up)", marginTop: 4 }}>
            Cash {fmtUsd(cash)} · Liabilities {fmtUsd(liabilities)}
          </div>
          <NetWorthChart cash={cash} invested={invested} liabilities={liabilities} netWorth={netWorth} signedIn={signedIn} />
        </Card>
        <Card>
          <div className="seclabel">Invested</div>
          <div className="bigmetric">{fmtUsd(invested)}</div>
        </Card>
        <Card>
          <div className="seclabel">Cash</div>
          <div className="bigmetric">{fmtUsd(cash)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
            {bankAccounts.length
              ? `${bankAccounts.length} account${bankAccounts.length === 1 ? "" : "s"} · Plaid`
              : plaidLinked
                ? "Plaid connected"
                : signedIn
                  ? "No bank linked"
                  : "Sign in to connect"}
          </div>
          {bankAccounts.length ? (
            bankAccounts.map((a) => (
              <div key={a.name + (a.mask ?? "")} className="metricrow" style={{ marginTop: 8 }}>
                <span className="metric-k">{a.name}{a.mask ? ` ··${a.mask}` : ""}</span>
                <span className="metric-v">{a.current != null ? fmtUsd(a.current) : "—"}</span>
              </div>
            ))
          ) : signedIn ? (
            <button type="button" className="feed-manage" style={{ marginTop: 14 }} onClick={connectBank}>
              {plaidConfigured ? "Link a bank" : "Connect bank · Plaid"}
            </button>
          ) : null}
        </Card>
      </div>

      <div className="divider" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card tick>
          <h2 className="sec">Top Movers<span className="rule" /><span className="count">Today</span></h2>
          {holdings.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>No holdings yet — add some on the Investing page.</p>
          ) : (
            <table className="holdings" style={{ marginTop: 8 }}>
              <tbody>
                {holdings.slice(0, 4).map((h) => {
                  const gain = holdingGain(h);
                  return (
                    <tr key={h.symbol}>
                      <td>{h.symbol}</td>
                      <td>{h.name}</td>
                      <td>{fmtUsd(holdingValue(h))}</td>
                      <td className={gain >= 0 ? "up" : "down"}>{gain >= 0 ? "▴" : "▾"} {Math.abs(gain).toFixed(1)}%</td>
                    </tr>
                  );
                })}
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
