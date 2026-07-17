"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";

type BankTxn = {
  id: string;
  merchant_name: string | null;
  raw_name: string | null;
  amount: number;
  plaid_category: string | null;
  custom_category: string | null;
  tags: string[] | null;
  is_transfer: boolean;
  excluded_from_budget: boolean;
  reviewed: boolean;
  pending: boolean;
  posted_date: string;
  /** Provenance: when this row was last pulled from Plaid (null until synced). */
  retrieved_at?: string | null;
};

type Budget = { id: string; category: string; monthly_limit: number };

const CATEGORIES = [
  "FOOD_AND_DRINK", "GROCERIES", "TRANSPORTATION", "MEDICAL", "ENTERTAINMENT",
  "SUBSCRIPTION", "RENT_AND_UTILITIES", "TRAVEL", "GENERAL_MERCHANDISE", "OTHER",
];

function fmtAmount(amount: number) {
  const abs = Math.abs(amount).toFixed(2);
  return amount >= 0 ? `+$${abs}` : `−$${abs}`;
}

type Status = "loading" | "ok" | "no-plaid" | "no-account" | "error";

export function FundSpendingModule() {
  const { toast } = useToast();
  const [txns, setTxns] = useState<BankTxn[]>([]);
  const txnsRef = useRef<BankTxn[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [addBudgetOpen, setAddBudgetOpen] = useState(false);
  const [newBudgetCategory, setNewBudgetCategory] = useState(CATEGORIES[0]);
  const [newBudgetLimit, setNewBudgetLimit] = useState("200");

  useEffect(() => {
    txnsRef.current = txns;
  }, [txns]);

  const load = useCallback(async () => {
    if (txnsRef.current.length === 0) setStatus("loading");
    setRefreshing(true);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryFilter) params.set("category", categoryFilter);
      if (unreviewedOnly) params.set("reviewed", "false");
      const res = await fetch(`/api/fund/bank-transactions?${params}`);
      if (res.status === 401) { setStatus("error"); return; }
      const data = await res.json();
      setTxns(data.transactions ?? []);
      setStatus("ok");
      setNotice(null);
    } catch {
      if (txnsRef.current.length > 0) {
        setStatus("ok");
        setNotice("Transaction refresh failed — showing last loaded results.");
      } else {
        setStatus("error");
      }
    } finally {
      setRefreshing(false);
    }
  }, [search, categoryFilter, unreviewedOnly]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch("/api/fund/category-budgets")
      .then((r) => r.json())
      .then((d: { budgets?: Budget[] }) => setBudgets(d.budgets ?? []))
      .catch(() => null);
  }, []);

  const spendByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of txns) {
      if (t.is_transfer || t.excluded_from_budget || t.amount >= 0) continue;
      const cat = t.custom_category ?? t.plaid_category ?? "OTHER";
      map.set(cat, (map.get(cat) ?? 0) + Math.abs(t.amount));
    }
    return map;
  }, [txns]);

  // Most recent real retrieval time across the loaded rows, for the freshness
  // badge. Only defined once at least one row actually carries a retrieved_at —
  // no fabricated "as of" (mirrors NetWorthChart's honest-signal rule).
  const latestRetrievedAt = useMemo(() => {
    let latest: number | null = null;
    for (const t of txns) {
      if (!t.retrieved_at) continue;
      const ms = Date.parse(t.retrieved_at);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    }
    return latest === null ? null : new Date(latest).toISOString();
  }, [txns]);

  async function patchTxn(id: string, patch: Partial<BankTxn>) {
    const res = await fetch(`/api/fund/bank-transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast("Couldn't save change.", "error", "Spending");
      return false;
    }
    setTxns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    return true;
  }

  async function splitTransaction(t: BankTxn) {
    const amountStr = window.prompt(`Split off how much from ${fmtAmount(t.amount)} (enter a positive number)?`);
    const splitAmount = Number(amountStr);
    if (!amountStr || !Number.isFinite(splitAmount) || splitAmount <= 0 || splitAmount >= Math.abs(t.amount)) return;

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const sign = t.amount < 0 ? -1 : 1;
    const remaining = t.amount - sign * splitAmount;
    const { data: child, error } = await supabase
      .from("fund_bank_transactions")
      .insert({
        user_id: user.id,
        plaid_transaction_id: `${t.id}-split-${Date.now()}`,
        merchant_name: t.merchant_name,
        raw_name: t.raw_name,
        amount: sign * splitAmount,
        plaid_category: t.plaid_category,
        posted_date: t.posted_date,
        split_parent_id: t.id,
      })
      .select()
      .single();

    if (error) {
      toast(error.message, "error", "Spending");
      return;
    }

    const parentUpdated = await patchTxn(t.id, { amount: remaining });
    if (!parentUpdated) {
      await supabase.from("fund_bank_transactions").delete().eq("id", child.id).eq("user_id", user.id);
      toast("Split was not saved because the original transaction could not be updated.", "error", "Spending");
      return;
    }

    setTxns((prev) => [...prev, child as BankTxn]);
    toast("Transaction split.", "success", "Spending");
  }

  async function addBudget() {
    const limit = Number(newBudgetLimit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const res = await fetch("/api/fund/category-budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: newBudgetCategory, monthly_limit: limit }),
    });
    if (!res.ok) { toast("Couldn't save budget.", "error", "Spending"); return; }
    const data = await res.json();
    setBudgets((prev) => [...prev.filter((b) => b.category !== newBudgetCategory), data.budget]);
    setAddBudgetOpen(false);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchant…"
          style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 6, padding: "8px 11px", color: "var(--ink)", fontFamily: "var(--mono)", fontSize: 11, outline: "none", minWidth: 180 }}
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 6, padding: "8px 11px", color: "var(--ink)", fontSize: 11 }}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-dim)" }}>
          <input type="checkbox" checked={unreviewedOnly} onChange={(e) => setUnreviewedOnly(e.target.checked)} />
          Unreviewed only
        </label>
      </div>

      <Card tick>
        <h2 className="sec">
          Transactions
          <span className="rule" />
          {latestRetrievedAt && (
            <span style={{ marginRight: 8 }}>
              <FreshnessBadge retrievedAt={latestRetrievedAt} sla={FRESHNESS_SLAS.accountBalance} />
            </span>
          )}
          <span className="count">{txns.length}</span>
        </h2>
        <div style={{ marginTop: 10 }}>
          {refreshing && txns.length > 0 && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Refreshing…</p>}
          {notice && <p style={{ fontSize: 12, color: "var(--clay)" }}>{notice}</p>}
          {status === "loading" && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>}
          {status === "error" && <p style={{ fontSize: 12, color: "var(--clay)" }}>Sign in to see transactions.</p>}
          {status === "ok" && txns.length === 0 && (
            <div className="empty-state"><strong>No transactions</strong><p>Link a bank on the Cash Flow page, or adjust filters.</p></div>
          )}
          {status === "ok" && txns.filter((t) => !t.is_transfer).map((t) => (
            <div key={t.id} className="txn" style={{ alignItems: "center" }}>
              <div className="txn-b">
                <div className="txn-t">
                  {t.merchant_name ?? t.raw_name}
                  {t.pending && <span style={{ marginLeft: 5, fontSize: 9, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>PENDING</span>}
                </div>
                <div className="txn-m">{(t.custom_category ?? t.plaid_category ?? "OTHER").replace(/_/g, " ")} · {t.posted_date}</div>
              </div>
              <select
                value={t.custom_category ?? t.plaid_category ?? "OTHER"}
                onChange={(e) => patchTxn(t.id, { custom_category: e.target.value })}
                style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 6, fontSize: 10, padding: "4px 6px", color: "var(--ink)", marginRight: 8 }}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--ink-faint)", marginRight: 8 }}>
                <input type="checkbox" checked={t.reviewed} onChange={(e) => patchTxn(t.id, { reviewed: e.target.checked })} />
                Reviewed
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--ink-faint)", marginRight: 8 }}>
                <input type="checkbox" checked={t.excluded_from_budget} onChange={(e) => patchTxn(t.id, { excluded_from_budget: e.target.checked })} />
                Exclude
              </label>
              <button type="button" onClick={() => splitTransaction(t)} style={{ background: "none", border: "none", color: "var(--ink-faint)", fontSize: 10, cursor: "pointer", marginRight: 8 }}>
                Split
              </button>
              <div className={`txn-v${t.amount >= 0 ? " up" : ""}`}>{fmtAmount(t.amount)}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="divider" />

      <Card>
        <h2 className="sec">Category Budgets<span className="rule" /><span className="count">{budgets.length}</span></h2>
        <div style={{ marginTop: 10 }}>
          {budgets.map((b) => {
            const spent = spendByCategory.get(b.category) ?? 0;
            const pct = b.monthly_limit ? (spent / b.monthly_limit) * 100 : 0;
            return (
              <div key={b.id} className="budgetbar">
                <div className="bl">
                  <span>{b.category.replace(/_/g, " ")}</span>
                  <span className="bv">${spent.toFixed(0)} / ${b.monthly_limit.toFixed(0)}</span>
                </div>
                <div className="track">
                  <div className={pct > 100 ? "over" : pct < 70 ? "good" : ""} style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <button type="button" className="feed-manage" style={{ marginTop: 14 }} onClick={() => setAddBudgetOpen(true)}>
          Set a budget
        </button>
      </Card>

      <Modal
        open={addBudgetOpen}
        onClose={() => setAddBudgetOpen(false)}
        title="Set category budget"
        footer={<>
          <Button variant="secondary" onClick={() => setAddBudgetOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={addBudget}>Save</Button>
        </>}
      >
        <div className="space-y-3">
          <select
            value={newBudgetCategory}
            onChange={(e) => setNewBudgetCategory(e.target.value)}
            className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
          </select>
          <input
            type="number" min="0" step="any"
            value={newBudgetLimit}
            onChange={(e) => setNewBudgetLimit(e.target.value)}
            placeholder="Monthly limit ($)"
            className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
          />
        </div>
      </Modal>
    </div>
  );
}
