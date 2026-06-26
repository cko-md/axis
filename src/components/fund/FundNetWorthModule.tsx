"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { NetWorthChart } from "@/components/fund/NetWorthChart";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { fmtUsd } from "@/lib/store/fund-defaults";

type Aggregated = { symbol: string; name: string; shares: number; cost_basis: number; sources: string[] };
type Liability = { id: string; name: string; balance: number };

export function FundNetWorthModule() {
  const { cash, plaidLinked } = usePlaidConnection();
  const [signedIn, setSignedIn] = useState(false);
  const [holdings, setHoldings] = useState<Aggregated[]>([]);
  const [liabilities, setLiabilities] = useState<Liability[]>([]);

  useEffect(() => {
    fetch("/api/fund/holdings")
      .then((r) => {
        setSignedIn(r.status !== 401);
        return r.json();
      })
      .then((d: { aggregated?: Aggregated[] }) => setHoldings(d.aggregated ?? []))
      .catch(() => null);
    fetch("/api/fund/liabilities")
      .then((r) => r.json())
      .then((d: { liabilities?: Liability[] }) => setLiabilities(d.liabilities ?? []))
      .catch(() => null);
  }, []);

  const invested = holdings.reduce((s, h) => s + h.cost_basis, 0);
  const liabilityTotal = liabilities.reduce((s, l) => s + Number(l.balance), 0);
  const netWorth = cash + invested - liabilityTotal;

  return (
    <div>
      <Card tick>
        <div className="seclabel">Net Worth</div>
        <div className="bigmetric" style={{ fontSize: 30 }}>{fmtUsd(netWorth)}</div>
        <NetWorthChart cash={cash} invested={invested} liabilities={liabilityTotal} netWorth={netWorth} signedIn={signedIn} showLiabilities />
      </Card>

      <div className="divider" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card>
          <h2 className="sec">Assets<span className="rule" /><span className="count">{fmtUsd(cash + invested)}</span></h2>
          <div style={{ marginTop: 10 }}>
            <div className="metricrow"><span className="metric-k">Cash {plaidLinked ? "· Plaid" : ""}</span><span className="metric-v">{fmtUsd(cash)}</span></div>
            {holdings.map((h) => (
              <div key={h.symbol} className="metricrow">
                <span className="metric-k">{h.symbol} · {h.sources.join("+")}</span>
                <span className="metric-v">{fmtUsd(h.cost_basis)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <h2 className="sec">Liabilities<span className="rule" /><span className="count">{fmtUsd(liabilityTotal)}</span></h2>
          <div style={{ marginTop: 10 }}>
            {liabilities.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>None tracked — add credit cards or loans on the Cash Flow page.</p>
            ) : (
              liabilities.map((l) => (
                <div key={l.id} className="metricrow"><span className="metric-k">{l.name}</span><span className="metric-v down">{fmtUsd(l.balance)}</span></div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
