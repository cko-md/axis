"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { fmtUsd } from "@/lib/store/fund-defaults";
import { useFundData } from "@/components/fund/FundDataProvider";

const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];

export function FundLiabilities() {
  const { toast } = useToast();
  // FUND-1: liabilities come from the shared layout store; mutations call
  // refreshLiabilities() so Cashflow/Net Worth/Overview stay consistent.
  const { liabilities, refreshLiabilities: load } = useFundData();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState(KINDS[0]);
  const [balance, setBalance] = useState("");
  const [minimumPayment, setMinimumPayment] = useState("");
  const [dueDate, setDueDate] = useState("");

  async function add() {
    const balanceNum = Number(balance);
    if (!name.trim() || !Number.isFinite(balanceNum) || balanceNum < 0) return;
    const res = await fetch("/api/fund/liabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, kind, balance: balanceNum,
        minimum_payment: minimumPayment ? Number(minimumPayment) : null,
        due_date: dueDate || null,
      }),
    });
    if (!res.ok) { toast("Couldn't save liability.", "error", "Cash Flow"); return; }
    await load();
    setOpen(false);
    setName(""); setBalance(""); setMinimumPayment(""); setDueDate("");
  }

  async function remove(id: string) {
    await fetch(`/api/fund/liabilities/${id}`, { method: "DELETE" });
    await load();
  }

  const total = liabilities.reduce((s, l) => s + Number(l.balance), 0);

  return (
    <Card>
      <h2 className="sec">Liabilities<span className="rule" /><span className="count">{fmtUsd(total)}</span></h2>
      <div style={{ marginTop: 10 }}>
        {liabilities.length === 0 ? (
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
                <button type="button" onClick={() => remove(l.id)} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer" }}>×</button>
              </span>
            </div>
          ))
        )}
      </div>
      <button type="button" className="feed-manage" style={{ marginTop: 14 }} onClick={() => setOpen(true)}>
        Add liability
      </button>

      <Modal
        open={open}
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
