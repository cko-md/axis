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
                        <td style={{ fontSize: 10, color: "var(--ink-faint)" }}>{h.sources.join(" + ")}</td>
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
