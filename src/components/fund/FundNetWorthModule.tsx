"use client";

import { Card } from "@/components/ui/Card";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { NetWorthChart } from "@/components/fund/NetWorthChart";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { useFundData } from "@/components/fund/FundDataProvider";
import { fmtUsd } from "@/lib/store/fund-defaults";
import { sumBy, sumMoney } from "@/lib/fund/money";

export function FundNetWorthModule() {
  const { cash, plaidLinked, balanceError } = usePlaidConnection();
  // FUND-1: holdings + liabilities come from the shared layout store, not a
  // per-mount fetch.
  const { aggregated: holdings, liabilities, plaidLiabilities, signedIn } = useFundData();

  const invested = sumBy(holdings, (h) => h.cost_basis);
  const manualLiabilityTotal = sumBy(liabilities, (l) => l.balance);
  const plaidLiabilityTotal = sumBy(plaidLiabilities, (l) => l.balanceCurrent ?? 0);
  const liabilityTotal = sumMoney([manualLiabilityTotal, plaidLiabilityTotal]);
  const netWorth = sumMoney([cash, invested, -liabilityTotal]);

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
          <h2 className="sec">Assets<span className="rule" /><span className="count">{fmtUsd(sumMoney([cash, invested]))}</span></h2>
          <div style={{ marginTop: 10 }}>
            <div className="metricrow"><span className="metric-k">Cash {plaidLinked ? "· Plaid" : ""}</span><span className="metric-v">{fmtUsd(cash)}</span></div>
            {balanceError && (
              <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 8 }}>Bank balances could not refresh.</p>
            )}
            {holdings.map((h) => (
              <div key={h.symbol} className="metricrow">
                <span className="metric-k" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {h.symbol} · {h.sources.join("+")}
                  <FreshnessBadge retrievedAt={h.retrieved_at ?? null} sla={FRESHNESS_SLAS.holdings} showRelative={false} />
                </span>
                <span className="metric-v">{fmtUsd(h.cost_basis)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <h2 className="sec">Liabilities<span className="rule" /><span className="count">{fmtUsd(liabilityTotal)}</span></h2>
          <div style={{ marginTop: 10 }}>
            {liabilities.length === 0 && plaidLiabilities.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>None tracked — add credit cards or loans on the Cash Flow page.</p>
            ) : (
              <>
                {plaidLiabilities.map((l) => (
                  <div key={l.accountId} className="metricrow">
                    <span className="metric-k" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {l.name ?? l.type} · Plaid
                      <FreshnessBadge retrievedAt={l.retrievedAt} sla={FRESHNESS_SLAS.accountBalance} showRelative={false} />
                    </span>
                    <span className="metric-v down">{fmtUsd(l.balanceCurrent ?? 0)}</span>
                  </div>
                ))}
                {liabilities.map((l) => (
                  <div key={l.id} className="metricrow"><span className="metric-k">{l.name}</span><span className="metric-v down">{fmtUsd(l.balance)}</span></div>
                ))}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
