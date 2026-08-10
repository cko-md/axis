"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { fmtUsd } from "@/lib/store/fund-defaults";
import { addMinorUnits, strictMinorUnits } from "@/lib/fund/financialTruth";
import { useFundData, type Liability } from "@/components/fund/FundDataProvider";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];

export function FundLiabilities() {
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
  // FUND-1: liabilities come from the shared layout store; mutations call
  // refreshLiabilities() so Cashflow/Net Worth/Overview stay consistent.
  const {
    liabilities,
    liabilitiesLoading,
    liabilitiesError,
    refreshLiabilities: load,
  } = useFundData();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState(KINDS[0]);
  const [balance, setBalance] = useState("");
  const [minimumPayment, setMinimumPayment] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [draftIdentity, setDraftIdentity] = useState<string | null>(currentIdentity);

  useEffect(() => {
    ++mutationGenerationRef.current;
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = null;
    setOpen(false);
    setName("");
    setKind(KINDS[0]);
    setBalance("");
    setMinimumPayment("");
    setDueDate("");
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

  async function add() {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject || draftIdentity !== currentIdentity) {
      toast("Sign in again before adding a liability.", "error", "Cash Flow");
      return;
    }
    const balanceNum = Number(balance);
    const minimumPaymentNum = minimumPayment ? Number(minimumPayment) : null;
    if (!name.trim() || !Number.isFinite(balanceNum) || balanceNum < 0) {
      toast("Enter a name and valid balance.", "warn", "Cash Flow");
      return;
    }
    if (minimumPaymentNum !== null && (!Number.isFinite(minimumPaymentNum) || minimumPaymentNum < 0)) {
      toast("Enter a valid minimum payment.", "warn", "Cash Flow");
      return;
    }
    const { controller, isCurrent } = beginMutation(expectedSubject, expectedEpoch);
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/fund/liabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          name, kind, balance: balanceNum,
          minimum_payment: minimumPaymentNum,
          due_date: dueDate || null,
          currency: "USD",
        }),
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (!isCurrent()) return;
        toast(err.error ?? "Couldn't save liability.", "error", "Cash Flow");
        return;
      }
      await load();
      if (!isCurrent()) return;
      setOpen(false);
      setName(""); setBalance(""); setMinimumPayment(""); setDueDate("");
    } catch {
      if (isCurrent()) toast("Couldn't save liability.", "error", "Cash Flow");
    }
  }

  async function remove(liability: Liability) {
    if (!window.confirm(`Remove ${liability.name} from liabilities?`)) return;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) return;
    const { controller, isCurrent } = beginMutation(expectedSubject, expectedEpoch);
    try {
      const res = await subjectBoundFetch(expectedSubject, `/api/fund/liabilities/${liability.id}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (!isCurrent()) return;
        toast(err.error ?? "Couldn't remove liability.", "error", "Cash Flow");
        return;
      }
      await load();
      if (!isCurrent()) return;
      toast("Liability removed.", "info", "Cash Flow");
    } catch {
      if (isCurrent()) toast("Couldn't remove liability.", "error", "Cash Flow");
    }
  }

  const visibleOpen = draftIdentity === currentIdentity && open;
  const openAddLiability = () => {
    setDraftIdentity(currentIdentity);
    setName("");
    setKind(KINDS[0]);
    setBalance("");
    setMinimumPayment("");
    setDueDate("");
    setOpen(true);
  };

  const total = (() => {
    if (liabilitiesLoading || liabilitiesError) return null;
    let totalMinor = 0;
    for (const liability of liabilities) {
      if ((liability.currency ?? "USD") !== "USD") return null;
      const amountMinor = strictMinorUnits(liability.balance, "USD");
      const next = amountMinor === null ? null : addMinorUnits(totalMinor, amountMinor);
      if (next === null) return null;
      totalMinor = next;
    }
    return totalMinor / 100;
  })();

  return (
    <Card>
      <h2 className="sec">Liabilities<span className="rule" /><span className="count">{total === null ? "—" : fmtUsd(total)}</span></h2>
      <div style={{ marginTop: 10 }}>
        {liabilitiesLoading && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>}
        {liabilitiesError && <p style={{ fontSize: 12, color: "var(--clay)", lineHeight: 1.6 }}>Liabilities could not refresh; no empty state is assumed.</p>}
        {!liabilitiesLoading && !liabilitiesError && liabilities.length === 0 ? (
          <div className="empty-state"><strong>No liabilities tracked</strong><p>Add credit cards or loans to see real net worth.</p></div>
        ) : (
          liabilities.map((l) => (
            <div key={l.id} className="metricrow" style={{ marginTop: 8 }}>
              <span className="metric-k">
                {l.name} · {l.kind.replace(/_/g, " ")}
                {l.due_date ? ` · due ${l.due_date}` : ""}
              </span>
              <span className="metric-v">
                {fmtUsd(l.balance)}
                <button type="button" onClick={() => remove(l)} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer" }}>×</button>
              </span>
            </div>
          ))
        )}
      </div>
      <button type="button" className="feed-manage" style={{ marginTop: 14 }} onClick={openAddLiability}>
        Add liability
      </button>

      <Modal
        open={visibleOpen}
        onClose={() => setOpen(false)}
        title="Add liability"
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={add}>Add</Button>
        </>}
      >
        <div className="space-y-3">
          <input placeholder="Name (e.g. Chase Sapphire)" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm">
            {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
          </select>
          <input type="number" min="0" step="any" placeholder="Balance ($)" value={balance} onChange={(e) => setBalance(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
          <input type="number" min="0" step="any" placeholder="Minimum payment ($, optional)" value={minimumPayment} onChange={(e) => setMinimumPayment(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
        </div>
      </Modal>
    </Card>
  );
}
