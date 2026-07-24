"use client";

import { Card } from "@/components/ui/Card";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { NetWorthChart } from "@/components/fund/NetWorthChart";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { useFundData } from "@/components/fund/FundDataProvider";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";

function formatExactUsd(value: string | null): string {
  if (value === null) return "—";
  const match = value.match(/^(-?)(\d+)\.(\d{2})$/);
  return match
    ? `${match[1]}$${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${match[3]}`
    : "—";
}

function formatFinancialAmount(value: unknown, currencyValue: unknown): string {
  const currency = normalizeFinancialCurrency(currencyValue, "");
  const minor = currency ? strictExactMinorUnits(value, currency) : null;
  const exact = currency && minor !== null ? minorUnitsToDecimalString(minor, currency) : null;
  if (!currency || exact === null) return "— · FX required";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(exact));
}

export function FundNetWorthModule() {
  const { cash, plaidLinked, balanceError, cashReason } = usePlaidConnection();
  // FUND-1: holdings + liabilities come from the shared layout store, not a
  // per-mount fetch.
  const {
    aggregated: holdings,
    liabilities,
    liabilitiesLoading,
    liabilitiesError,
    plaidLiabilities,
    plaidLiabilitiesState,
    plaidLiabilitiesConnected,
    signedIn,
  } = useFundData();

  // Manual and Plaid liability rows can describe the same debt. Do not blend
  // them into an authoritative total until a reconciliation key exists.

  return (
    <div>
      <Card tick>
        <div className="seclabel">Net Worth</div>
        <div className="bigmetric" style={{ fontSize: 30 }}>—</div>
        <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 8 }}>Live net worth requires complete provider coverage.</p>
        <NetWorthChart signedIn={signedIn} showLiabilities />
      </Card>

      <div className="divider" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card>
          <h2 className="sec">Assets<span className="rule" /><span className="count">Live value unavailable</span></h2>
          <div style={{ marginTop: 10 }}>
            <div className="metricrow"><span className="metric-k">Cash {plaidLinked ? "· Plaid" : ""}</span><span className="metric-v">{formatExactUsd(cash)}</span></div>
            {balanceError && !cashReason && (
              <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 8 }}>Bank balances could not refresh.</p>
            )}
            {cashReason && <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 8 }}>Cash unavailable: {cashReason}</p>}
            {holdings.map((h) => (
              <div key={h.symbol} className="metricrow">
                <span className="metric-k" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {h.symbol} · {h.sources.join("+")}
                  <FreshnessBadge retrievedAt={h.retrieved_at ?? null} sla={FRESHNESS_SLAS.holdings} showRelative={false} />
                </span>
                <span className="metric-v">
                  {h.cost_basis === null
                    ? "— · FX required"
                    : `${formatFinancialAmount(h.cost_basis, h.currency)} cost basis`}
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <h2 className="sec">Liabilities<span className="rule" /><span className="count">— · Provider/manual totals not combined</span></h2>
          <div style={{ marginTop: 10 }}>
            {liabilitiesError && (
              <p style={{ fontSize: 12, color: "var(--clay)", marginBottom: 8 }}>
                Manual liabilities unavailable; no empty result is assumed.
              </p>
            )}
            {plaidLiabilitiesState === "unavailable" && (
              <p style={{ fontSize: 12, color: "var(--clay)", marginBottom: 8 }}>
                Plaid liabilities unavailable; no provider-empty result is assumed.
              </p>
            )}
            {(liabilitiesLoading || plaidLiabilitiesState === "loading") && liabilities.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading liabilities…</p>
            ) : !liabilitiesError && plaidLiabilitiesState === "ready" && liabilities.length === 0 && plaidLiabilities.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>
                {plaidLiabilitiesConnected === false
                  ? "No Plaid liability source is linked; no manual liabilities are tracked."
                  : "None tracked — add credit cards or loans on the Cash Flow page."}
              </p>
            ) : (
              <>
                {plaidLiabilities.map((l) => (
                  <div key={l.accountId} className="metricrow">
                    <span className="metric-k" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {l.name ?? l.type} · Plaid
                      <FreshnessBadge retrievedAt={l.retrievedAt} sla={FRESHNESS_SLAS.accountBalance} showRelative={false} />
                    </span>
                    <span className="metric-v down">
                      {l.balanceCurrent === null ? "—" : formatFinancialAmount(l.balanceCurrent, l.currency)}
                    </span>
                  </div>
                ))}
                {liabilities.map((l) => (
                  <div key={l.id} className="metricrow">
                    <span className="metric-k">{l.name} · manual</span>
                    <span className="metric-v down">{formatFinancialAmount(l.balance, l.currency)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
