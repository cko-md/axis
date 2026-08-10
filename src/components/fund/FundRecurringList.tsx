"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { sumBy } from "@/lib/fund/money";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type Recurring = {
  id: string;
  merchant_name: string;
  expected_amount: number;
  cadence: string;
  next_expected_date: string | null;
  status: string;
};

export function FundRecurringList() {
  const { toast } = useToast();
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [recurringIdentity, setRecurringIdentity] = useState<string | null>(null);

  const load = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRecurring([]);
    setLoaded(false);
    setRecurringIdentity(null);
    setNotice(null);
    if (!expectedSubject) return;
    const isCurrent = () => !controller.signal.aborted
      && generationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/fund/recurring", { signal: controller.signal });
      if (!isCurrent()) return;
      const data = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!res.ok) throw new Error(data.error ?? "recurring_unavailable");
      setRecurring((data.recurring ?? []).filter((r: Recurring) => r.status === "active"));
      setRecurringIdentity(`${expectedSubject}:${expectedEpoch}`);
    } catch {
      if (isCurrent()) {
        setNotice("Recurring charges could not refresh.");
        setRecurringIdentity(`${expectedSubject}:${expectedEpoch}`);
      }
    } finally {
      if (isCurrent()) setLoaded(true);
    }
  }, [authorityEpoch, currentSubject]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [load]);

  async function setStatus(id: string, status: "cancelled" | "active") {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject || recurringIdentity !== currentIdentity) return;
    const res = await subjectBoundFetch(expectedSubject, `/api/fund/recurring/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (currentSubjectRef.current !== expectedSubject || authorityEpochRef.current !== expectedEpoch) return;
    if (!res.ok) {
      toast("Could not update recurring charge.", "error", "Cash Flow");
      return;
    }
    setRecurring((prev) => prev.filter((r) => r.id !== id));
    toast("Recurring charge dismissed.", "info", "Cash Flow");
  }

  const visibleRecurring = recurringIdentity === currentIdentity ? recurring : [];
  const visibleLoaded = recurringIdentity === currentIdentity && loaded;
  const visibleNotice = recurringIdentity === currentIdentity ? notice : null;
  const monthlyTotal = sumBy(visibleRecurring, (r) => r.expected_amount);

  return (
    <Card tick>
      <h2 className="sec">Recurring<span className="rule" /><span className="count">${monthlyTotal.toFixed(0)}/mo</span></h2>
      <div style={{ marginTop: 10 }}>
        {!visibleLoaded && <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>}
        {visibleNotice && <p style={{ fontSize: 12, color: "var(--clay)", lineHeight: 1.6 }}>{visibleNotice}</p>}
        {visibleLoaded && visibleRecurring.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
            No recurring charges detected yet — the finance-daily job finds these once you have a few months of synced transactions.
          </p>
        )}
        {visibleRecurring.map((r) => (
          <div key={r.id} className="metricrow" style={{ marginTop: 8 }}>
            <span className="metric-k">
              {r.merchant_name} · {r.cadence}
              {r.next_expected_date ? ` · next ${r.next_expected_date}` : ""}
            </span>
            <span className="metric-v">
              ${r.expected_amount.toFixed(2)}
              <button type="button" onClick={() => setStatus(r.id, "cancelled")} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 10 }}>
                dismiss
              </button>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
