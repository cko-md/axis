"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { ACTIVITY_CATEGORIES } from "@/lib/fund/activityRules";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { minorUnitsFor } from "@/lib/fund/currency";
import { formatSignedMinorCurrency } from "@/lib/fund/formatMinorCurrency";
import { addMinorUnits } from "@/lib/fund/financialTruth";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type BankTxn = {
  id: string;
  merchant_name: string | null;
  raw_name: string | null;
  amount: number;
  amount_minor: number | null;
  iso_currency_code: string;
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

type Budget = { id: string; category: string; monthly_limit: number; currency: string };

const CATEGORIES = ACTIVITY_CATEGORIES;

type Status = "loading" | "ok" | "no-plaid" | "no-account" | "error";
const TRANSACTION_PAGE_SIZE = 500;
const MAX_TRANSACTION_ROWS = 20_000;

export function aggregateBudgetSpend(
  transactions: readonly BankTxn[],
): Map<string, number | null> {
  const totals = new Map<string, number | null>();
  for (const transaction of transactions) {
    if (
      transaction.is_transfer
      || transaction.excluded_from_budget
      || transaction.amount >= 0
      || transaction.amount_minor === null
    ) continue;
    const category = transaction.custom_category ?? transaction.plaid_category ?? "OTHER";
    const key = `${category}\u0000${transaction.iso_currency_code}`;
    const previous = totals.get(key);
    if (previous === null) continue;
    const next = addMinorUnits(previous ?? 0, Math.abs(transaction.amount_minor));
    totals.set(key, next);
  }
  return totals;
}

export function FundSpendingModule() {
  const { toast } = useToast();
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const loadGenerationRef = useRef(0);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
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
  const [newBudgetCategory, setNewBudgetCategory] = useState<string>(CATEGORIES[0]);
  const [newBudgetLimit, setNewBudgetLimit] = useState("200");
  const [txnsIdentity, setTxnsIdentity] = useState<string | null>(null);
  const [budgetsIdentity, setBudgetsIdentity] = useState<string | null>(null);
  const txnsIdentityRef = useRef(txnsIdentity);
  txnsIdentityRef.current = txnsIdentity;

  useEffect(() => {
    txnsRef.current = txns;
  }, [txns]);

  const load = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const expectedIdentity = expectedSubject ? `${expectedSubject}:${expectedEpoch}` : null;
    const generation = ++loadGenerationRef.current;
    const controller = new AbortController();
    const hadCurrentRows = txnsIdentityRef.current === expectedIdentity && txnsRef.current.length > 0;
    if (!expectedSubject) {
      setTxns([]);
      setTxnsIdentity(null);
      setStatus("error");
      setNotice("Sign in to view transactions.");
      setRefreshing(false);
      return;
    }
    const isCurrent = () => !controller.signal.aborted
      && loadGenerationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    if (!hadCurrentRows) setStatus("loading");
    setRefreshing(true);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryFilter) params.set("category", categoryFilter);
      if (unreviewedOnly) params.set("reviewed", "false");
      params.set("limit", String(TRANSACTION_PAGE_SIZE));
      const loaded: BankTxn[] = [];
      let lineageHash: string | null = null;
      for (let offset = 0; offset < MAX_TRANSACTION_ROWS; offset += TRANSACTION_PAGE_SIZE) {
        params.set("offset", String(offset));
        const res = await subjectBoundFetch(expectedSubject, `/api/fund/bank-transactions?${params}`, { signal: controller.signal });
        if (!isCurrent()) return;
        if (res.status === 401) { setStatus("error"); setTxnsIdentity(expectedIdentity); return; }
        if (!res.ok) throw new Error("TRANSACTION_HISTORY_UNAVAILABLE");
        const data = await res.json() as {
          transactions?: BankTxn[];
          completeness?: string;
          lineageHash?: unknown;
          page?: { hasMore?: boolean };
        };
        if (!isCurrent()) return;
        if (
          data.completeness !== "complete_source_page"
          || !Array.isArray(data.transactions)
          || typeof data.lineageHash !== "string"
          || !/^[0-9a-f]{64}$/.test(data.lineageHash)
          || (lineageHash !== null && lineageHash !== data.lineageHash)
        ) {
          throw new Error("TRANSACTION_HISTORY_INCOMPLETE");
        }
        lineageHash = data.lineageHash;
        loaded.push(...data.transactions);
        if (!data.page?.hasMore) break;
        if (offset + TRANSACTION_PAGE_SIZE >= MAX_TRANSACTION_ROWS) {
          throw new Error("TRANSACTION_HISTORY_LIMIT_EXCEEDED");
        }
      }
      if (!isCurrent()) return;
      setTxns(loaded);
      setTxnsIdentity(expectedIdentity);
      setStatus("ok");
      setNotice(null);
    } catch {
      if (!isCurrent()) return;
      if (hadCurrentRows) {
        setStatus("ok");
        setNotice("Transaction refresh failed — showing last loaded results.");
      } else {
        setTxns([]);
        setTxnsIdentity(expectedIdentity);
        setStatus("error");
        setNotice("Complete transaction history is unavailable; no totals are shown.");
      }
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [authorityEpoch, categoryFilter, currentSubject, search, unreviewedOnly]);

  useEffect(() => {
    void load();
    return () => { loadGenerationRef.current += 1; };
  }, [load]);
  useEffect(() => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    let active = true;
    setBudgets([]);
    setBudgetsIdentity(null);
    if (!expectedSubject) return () => { active = false; };
    void subjectBoundFetch(expectedSubject, "/api/fund/category-budgets")
      .then(async (response) => ({ response, body: await response.json() as { budgets?: Budget[] } }))
      .then(({ response, body }) => {
        if (!active || currentSubjectRef.current !== expectedSubject || authorityEpochRef.current !== expectedEpoch) return;
        if (!response.ok) throw new Error("BUDGETS_UNAVAILABLE");
        setBudgets(body.budgets ?? []);
        setBudgetsIdentity(`${expectedSubject}:${expectedEpoch}`);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [authorityEpoch, currentSubject]);

  const visibleTxns = txnsIdentity === currentIdentity ? txns : [];
  const visibleBudgets = budgetsIdentity === currentIdentity ? budgets : [];
  const visibleStatus = txnsIdentity === currentIdentity ? status : "loading";
  const visibleNotice = txnsIdentity === currentIdentity ? notice : null;
  const visibleRefreshing = txnsIdentity === currentIdentity && refreshing;

  const spendByCategoryCurrency = useMemo(() => aggregateBudgetSpend(visibleTxns), [visibleTxns]);

  // Most recent real retrieval time across the loaded rows, for the freshness
  // badge. Only defined once at least one row actually carries a retrieved_at —
  // no fabricated "as of" (mirrors NetWorthChart's honest-signal rule).
  const latestRetrievedAt = useMemo(() => {
    let latest: number | null = null;
    for (const t of visibleTxns) {
      if (!t.retrieved_at) continue;
      const ms = Date.parse(t.retrieved_at);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    }
    return latest === null ? null : new Date(latest).toISOString();
  }, [visibleTxns]);

  async function patchTxn(id: string, patch: Partial<BankTxn>) {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject || txnsIdentity !== currentIdentity) return false;
    const res = await subjectBoundFetch(expectedSubject, `/api/fund/bank-transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (currentSubjectRef.current !== expectedSubject || authorityEpochRef.current !== expectedEpoch) return false;
    if (!res.ok) {
      toast("Couldn't save change.", "error", "Spending");
      return false;
    }
    setTxns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    return true;
  }

  async function addBudget() {
    const limit = Number(newBudgetLimit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) return;
    const res = await subjectBoundFetch(expectedSubject, "/api/fund/category-budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: newBudgetCategory, monthly_limit: limit, currency: "USD" }),
    });
    if (currentSubjectRef.current !== expectedSubject || authorityEpochRef.current !== expectedEpoch) return;
    if (!res.ok) { toast("Couldn't save budget.", "error", "Spending"); return; }
    const data = await res.json();
    setBudgets((prev) => [
      ...prev.filter((b) => !(b.category === newBudgetCategory && b.currency === "USD")),
      data.budget,
    ]);
    setBudgetsIdentity(`${expectedSubject}:${expectedEpoch}`);
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
          <span className="count">{visibleTxns.length}</span>
        </h2>
        <div style={{ marginTop: 10 }}>
          {visibleRefreshing && visibleTxns.length > 0 && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Refreshing…</p>}
          {visibleNotice && <p style={{ fontSize: 12, color: "var(--clay)" }}>{visibleNotice}</p>}
          {visibleStatus === "loading" && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>}
          {visibleStatus === "error" && <p style={{ fontSize: 12, color: "var(--clay)" }}>{visibleNotice ?? "Transactions are unavailable."}</p>}
          {visibleStatus === "ok" && visibleTxns.length === 0 && (
            <div className="empty-state"><strong>No transactions</strong><p>Link a bank on the Cash Flow page, or adjust filters.</p></div>
          )}
          {visibleStatus === "ok" && visibleTxns.filter((t) => !t.is_transfer).map((t) => (
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
              <div className={`txn-v${(t.amount_minor ?? -1) >= 0 ? " up" : ""}`}>
                {t.amount_minor === null
                  ? "Amount unavailable"
                  : formatSignedMinorCurrency(t.amount_minor, t.iso_currency_code) ?? "Amount unavailable"}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="divider" />

      <Card>
        <h2 className="sec">Category Budgets<span className="rule" /><span className="count">{visibleBudgets.length}</span></h2>
        <div style={{ marginTop: 10 }}>
          {visibleBudgets.map((b) => {
            const spendKey = `${b.category}\u0000${b.currency}`;
            const spentMinor = spendByCategoryCurrency.has(spendKey)
              ? spendByCategoryCurrency.get(spendKey) ?? null
              : 0;
            const spent = spentMinor === null ? null : spentMinor / minorUnitsFor(b.currency);
            const pct = spent === null ? null : b.monthly_limit ? (spent / b.monthly_limit) * 100 : 0;
            const format = new Intl.NumberFormat("en-US", { style: "currency", currency: b.currency });
            return (
              <div key={b.id} className="budgetbar">
                <div className="bl">
                  <span>{b.category.replace(/_/g, " ")}</span>
                  <span className="bv">{spent === null ? "Spend unavailable" : `${format.format(spent)} / ${format.format(b.monthly_limit)}`}</span>
                </div>
                <div className="track">
                  <div className={pct === null ? "" : pct > 100 ? "over" : pct < 70 ? "good" : ""} style={{ width: pct === null ? "0%" : `${Math.min(pct, 100)}%` }} />
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
