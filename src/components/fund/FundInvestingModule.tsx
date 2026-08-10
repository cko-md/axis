"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { FundOrderTicket } from "@/components/fund/FundOrderTicket";
import { FundSparkline } from "@/components/fund/FundSparkline";
import { usePlaidConnection } from "@/lib/fund/usePlaidConnection";
import { useFundData } from "@/components/fund/FundDataProvider";
import { reconciliationView } from "@/lib/fund/reconciliationView";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

function formatHoldingCost(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

export function FundInvestingModule() {
  const { toast } = useToast();
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const mutationGenerationRef = useRef(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const { brokerageConfigured, brokerageStatusState } = usePlaidConnection();
  // FUND-1: holdings come from the shared layout store; mutations call
  // refreshHoldings() so Net Worth/Overview reflect changes with no extra fetch.
  const {
    rows,
    aggregated,
    holdingsLoading,
    holdingsError,
    refreshHoldings: load,
  } = useFundData();
  const [addOpen, setAddOpen] = useState(false);
  const [addSym, setAddSym] = useState("");
  const [addName, setAddName] = useState("");
  const [addShares, setAddShares] = useState("1");
  const [addCost, setAddCost] = useState("0");
  const [draftIdentity, setDraftIdentity] = useState<string | null>(currentIdentity);
  const concentrationLimit = 0.25;

  useEffect(() => {
    ++mutationGenerationRef.current;
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = null;
    setAddOpen(false);
    setAddSym("");
    setAddName("");
    setAddShares("1");
    setAddCost("0");
    setDraftIdentity(currentIdentity);
    return () => {
      mutationControllerRef.current?.abort();
      mutationControllerRef.current = null;
    };
  }, [currentIdentity]);

  function beginMutation(expectedSubject: string, expectedEpoch: number) {
    const generation = ++mutationGenerationRef.current;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    return {
      controller,
      isCurrent: () => !controller.signal.aborted
        && mutationGenerationRef.current === generation
        && currentSubjectRef.current === expectedSubject
        && authorityEpochRef.current === expectedEpoch,
    };
  }

  async function addHolding() {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject || draftIdentity !== currentIdentity) {
      toast("Sign in again before adding a holding.", "error", "Investing");
      return;
    }
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
    const { controller, isCurrent } = beginMutation(expectedSubject, expectedEpoch);
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/fund/holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          symbol,
          name: addName.trim() || symbol,
          shares,
          cost_basis: costBasis,
          currency: "USD",
        }),
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (!isCurrent()) return;
        toast(err.error ?? "Couldn't add holding.", "error", "Investing");
        return;
      }
      await load();
      if (!isCurrent()) return;
      setAddOpen(false);
      setAddSym(""); setAddName(""); setAddShares("1"); setAddCost("0");
    } catch {
      if (isCurrent()) toast("Couldn't add holding.", "error", "Investing");
    }
  }

  async function removeHolding(id: string) {
    const row = rows.find((r) => r.id === id);
    const label = row ? `${row.symbol} (${row.source})` : "this holding";
    if (!window.confirm(`Remove ${label} from holdings?`)) return;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) return;
    const { controller, isCurrent } = beginMutation(expectedSubject, expectedEpoch);
    try {
      const res = await subjectBoundFetch(expectedSubject, `/api/fund/holdings/${id}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (!isCurrent()) return;
        toast(err.error ?? "Couldn't remove holding.", "error", "Investing");
        return;
      }
      await load();
      if (!isCurrent()) return;
      toast("Holding removed.", "info", "Investing");
    } catch {
      if (isCurrent()) toast("Couldn't remove holding.", "error", "Investing");
    }
  }

  const visibleAddOpen = draftIdentity === currentIdentity && addOpen;
  const openAddHolding = () => {
    setDraftIdentity(currentIdentity);
    setAddSym("");
    setAddName("");
    setAddShares("1");
    setAddCost("0");
    setAddOpen(true);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button type="button" className="feed-manage" onClick={openAddHolding}>Add holding</button>
      </div>

      {aggregated[0] && <FundSparkline symbol={aggregated[0].symbol} />}

      <div className="divider" />
      {brokerageStatusState === "unavailable" && (
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--clay)" }}>
          Brokerage connection status is unavailable. Live submission remains disabled; reviewable intent capture is still available.
        </p>
      )}
      {holdingsError && aggregated.length > 0 && (
        <p role="alert" style={{ margin: "0 0 12px", fontSize: 12, color: "var(--clay)" }}>
          Holdings refresh failed — showing the last successfully loaded positions.
        </p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card tick>
          <h2 className="sec">Holdings<span className="rule" /><span className="count">{aggregated.length} positions</span></h2>
          {holdingsLoading && aggregated.length === 0 ? (
            <div className="empty-state"><strong>Loading holdings…</strong></div>
          ) : holdingsError && aggregated.length === 0 ? (
            <div className="empty-state" role="alert"><strong>Holdings unavailable</strong><p>AXIS could not verify your positions. Retry before relying on portfolio totals.</p></div>
          ) : aggregated.length === 0 ? (
            <div className="empty-state"><strong>No holdings yet</strong><p>Add your first position to start tracking net worth.</p></div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="holdings" style={{ marginTop: 10 }}>
                <thead><tr><th>Symbol</th><th>Name</th><th>Shares</th><th>Cost</th><th>Source</th><th /></tr></thead>
                <tbody>
                  {aggregated.map((h) => {
                    const rowIds = rows
                      .filter((r) => r.symbol === h.symbol && r.authority === "manual")
                      .map((r) => r.id);
                    return (
                      <tr key={h.symbol}>
                        <td><a href={`/fund/position/${h.symbol}`} style={{ color: "var(--accent)" }}>{h.symbol}</a></td>
                        <td>{h.name}</td>
                        <td>{h.shares}</td>
                        <td>{h.cost_basis === null || !h.currency ? "— · FX required" : formatHoldingCost(h.cost_basis, h.currency)}</td>
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
          <h2 className="sec">Allocation<span className="rule" /><span className="count">Current value required</span></h2>
          {holdingsLoading && aggregated.length === 0 ? (
            <div className="empty-state"><strong>Loading allocation…</strong></div>
          ) : holdingsError && aggregated.length === 0 ? (
            <div className="empty-state" role="alert"><strong>Allocation unavailable</strong><p>Holdings could not be verified.</p></div>
          ) : aggregated.length === 0 ? (
            <div className="empty-state"><strong>No allocation yet</strong><p>Add holdings to see portfolio weights.</p></div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--clay)", lineHeight: 1.6, marginTop: 10 }}>
              Allocation is withheld until every position has a fresh provider-verified quantity and market quote. Cost basis is historical and is never used as current market value.
            </p>
          )}
        </Card>
        <Card>
          <h2 className="sec">Concentration<span className="rule" /><span className="count">Max {(concentrationLimit * 100).toFixed(0)}%</span></h2>
          {holdingsLoading && aggregated.length === 0 ? (
            <div className="empty-state"><strong>Loading concentration…</strong></div>
          ) : holdingsError && aggregated.length === 0 ? (
            <div className="empty-state" role="alert"><strong>Concentration unavailable</strong><p>Holdings could not be verified.</p></div>
          ) : aggregated.length === 0 ? (
            <div className="empty-state"><strong>No concentration yet</strong><p>Add holdings to check position weights.</p></div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--clay)", lineHeight: 1.6, marginTop: 10 }}>
              Concentration is withheld until complete current market values are available. Historical cost basis cannot establish portfolio weights.
            </p>
          )}
        </Card>
        <FundOrderTicket defaultSymbol={aggregated[0]?.symbol ?? ""} brokerageConfigured={brokerageConfigured} />
      </div>

      <Modal
        open={visibleAddOpen}
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
