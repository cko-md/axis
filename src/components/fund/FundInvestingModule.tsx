"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { fmtUsd } from "@/lib/store/fund-defaults";
import { FundOrderTicket } from "@/components/fund/FundOrderTicket";
import { FundSparkline } from "@/components/fund/FundSparkline";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { useFundData } from "@/components/fund/FundDataProvider";
import { reconciliationView } from "@/lib/fund/reconciliationView";
import { calculateAllocation } from "@/lib/fund/portfolioPerformance";
import { reviewConcentration } from "@/lib/skills/concentrationReview";

export function FundInvestingModule() {
  const { toast } = useToast();
  const { brokerageConfigured } = usePlaidConnection();
  // FUND-1: holdings come from the shared layout store; mutations call
  // refreshHoldings() so Net Worth/Overview reflect changes with no extra fetch.
  const { rows, aggregated, refreshHoldings: load } = useFundData();
  const [addOpen, setAddOpen] = useState(false);
  const [addSym, setAddSym] = useState("");
  const [addName, setAddName] = useState("");
  const [addShares, setAddShares] = useState("1");
  const [addCost, setAddCost] = useState("0");
  const concentrationLimit = 0.25;
  const hasMixedCurrency = aggregated.some((holding) => !holding.currency);
  const allocation = hasMixedCurrency
    ? null
    : calculateAllocation(
        aggregated.map((holding) => ({
          key: holding.symbol,
          label: holding.name,
          value: holding.cost_basis,
          currency: holding.currency,
        })),
      );
  const concentration = hasMixedCurrency
    ? null
    : reviewConcentration(
        aggregated.map((holding) => ({ symbol: holding.symbol, value: holding.cost_basis })),
        concentrationLimit,
      );

  async function addHolding() {
    const symbol = addSym.trim().toUpperCase();
    const shares = Number(addShares);
    const costBasis = Number(addCost);
    if (!symbol) {
      toast("Enter a symbol.", "warn", "Investing");
      return;
    }
    if (!Number.isFinite(shares) || shares < 0) {
      toast("Enter a valid share count.", "warn", "Investing");
      return;
    }
    if (!Number.isFinite(costBasis) || costBasis < 0) {
      toast("Enter a valid cost basis.", "warn", "Investing");
      return;
    }
    const res = await fetch("/api/fund/holdings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        name: addName.trim() || symbol,
        shares,
        cost_basis: costBasis,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error ?? "Couldn't add holding.", "error", "Investing");
      return;
    }
    await load();
    setAddOpen(false);
    setAddSym(""); setAddName(""); setAddShares("1"); setAddCost("0");
  }

  async function removeHolding(id: string) {
    const row = rows.find((r) => r.id === id);
    const label = row ? `${row.symbol} (${row.source})` : "this holding";
    if (!window.confirm(`Remove ${label} from holdings?`)) return;
    const res = await fetch(`/api/fund/holdings/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error ?? "Couldn't remove holding.", "error", "Investing");
      return;
    }
    await load();
    toast("Holding removed.", "info", "Investing");
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button type="button" className="feed-manage" onClick={() => setAddOpen(true)}>Add holding</button>
      </div>

      {aggregated[0] && <FundSparkline symbol={aggregated[0].symbol} />}

      <div className="divider" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card tick>
          <h2 className="sec">Holdings<span className="rule" /><span className="count">{aggregated.length} positions</span></h2>
          {aggregated.length === 0 ? (
            <div className="empty-state"><strong>No holdings yet</strong><p>Add your first position to start tracking net worth.</p></div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="holdings" style={{ marginTop: 10 }}>
                <thead><tr><th>Symbol</th><th>Name</th><th>Shares</th><th>Cost</th><th>Source</th><th /></tr></thead>
                <tbody>
                  {aggregated.map((h) => {
                    const rowIds = rows.filter((r) => r.symbol === h.symbol).map((r) => r.id);
                    return (
                      <tr key={h.symbol}>
                        <td><a href={`/fund/position/${h.symbol}`} style={{ color: "var(--accent)" }}>{h.symbol}</a></td>
                        <td>{h.name}</td>
                        <td>{h.shares}</td>
                        <td>{fmtUsd(h.cost_basis)}</td>
                        <td style={{ fontSize: 10, color: "var(--ink-faint)" }}>
                          {h.sources.join(" + ")}
                          {(() => {
                            const recon = reconciliationView(h.reconciliation_state);
                            if (!recon) return null;
                            return (
                              <span
                                role="status"
                                aria-label={`${recon.label}: ${recon.description}`}
                                title={recon.description}
                                style={{ marginLeft: 6, color: recon.color, fontWeight: recon.tone === "danger" ? 600 : 400 }}
                              >
                                {recon.label}
                              </span>
                            );
                          })()}
                        </td>
                        <td>
                          {rowIds.map((id) => (
                            <button key={id} type="button" title="Remove" onClick={() => removeHolding(id)} style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer" }}>×</button>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <h2 className="sec">Allocation<span className="rule" /><span className="count">{allocation?.ok ? allocation.value.currency : "FX needed"}</span></h2>
          {aggregated.length === 0 ? (
            <div className="empty-state"><strong>No allocation yet</strong><p>Add holdings to see portfolio weights.</p></div>
          ) : !allocation?.ok ? (
            <p style={{ fontSize: 12, color: "var(--clay)", lineHeight: 1.6, marginTop: 10 }}>
              Allocation needs one currency or explicit FX rates before weights can be shown.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {allocation.value.slices.map((slice) => (
                <div key={slice.key}>
                  <div className="metricrow" style={{ marginBottom: 4 }}>
                    <span className="metric-k">{slice.key}</span>
                    <span className="metric-v">{(slice.weight * 100).toFixed(1)}%</span>
                  </div>
                  <div aria-hidden="true" style={{ height: 6, borderRadius: 4, background: "var(--surface-2)", overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(100, slice.weight * 100)}%`, height: "100%", background: "var(--accent)" }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <h2 className="sec">Concentration<span className="rule" /><span className="count">Max {(concentrationLimit * 100).toFixed(0)}%</span></h2>
          {aggregated.length === 0 ? (
            <div className="empty-state"><strong>No concentration yet</strong><p>Add holdings to check position weights.</p></div>
          ) : !concentration ? (
            <p style={{ fontSize: 12, color: "var(--clay)", lineHeight: 1.6, marginTop: 10 }}>
              Concentration needs one currency or explicit FX rates before position weights can be shown.
            </p>
          ) : concentration.breaches.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: 10 }}>
              No position is above the {(concentrationLimit * 100).toFixed(0)}% review threshold.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {concentration.breaches.map((breach) => (
                <div key={breach.symbol} className="metricrow">
                  <span className="metric-k">{breach.symbol} · {(breach.weight * 100).toFixed(1)}%</span>
                  <span className="metric-v down">{fmtUsd(breach.overByValue)} over</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <FundOrderTicket defaultSymbol={aggregated[0]?.symbol ?? ""} brokerageConfigured={brokerageConfigured} />
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add holding"
        footer={<>
          <Button variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={addHolding}>Add</Button>
        </>}
      >
        <div className="space-y-3">
          <input placeholder="Symbol (e.g. AAPL)" value={addSym} onChange={(e) => setAddSym(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
          <input placeholder="Name (optional)" value={addName} onChange={(e) => setAddName(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-[var(--ink-dim)]">Shares
              <input type="number" min="0" step="any" value={addShares} onChange={(e) => setAddShares(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
            </label>
            <label className="flex-1 text-xs text-[var(--ink-dim)]">Total cost basis ($)
              <input type="number" min="0" step="any" value={addCost} onChange={(e) => setAddCost(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
