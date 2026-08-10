"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type Insight = {
  ic: string;
  icColor?: string;
  title: string;
  meta: string;
  value: string;
  up: boolean;
};

type Budget = {
  label: string;
  spent: string;
  pct: number;
  cls: string;
};

export function FundBudget() {
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [insights, setInsights] = useState<Insight[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "no-plaid" | "no-account" | "error">(
    "loading",
  );
  const [dataIdentity, setDataIdentity] = useState<string | null>(null);

  const load = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setInsights([]);
    setBudgets([]);
    setStatus("loading");
    setDataIdentity(null);
    if (!expectedSubject) return;
    const isCurrent = () => !controller.signal.aborted
      && generationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/plaid/budget", {
        method: "POST",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const data = await res.json();
      if (!isCurrent()) return;
      const identity = `${expectedSubject}:${expectedEpoch}`;
      setDataIdentity(identity);
      if (!data.configured) { setStatus("no-plaid"); return; }
      if (data.error === "NO_LINKED_ACCOUNT") { setStatus("no-account"); return; }
      if (!res.ok || data.error) { setStatus("error"); return; }
      setInsights(data.insights ?? []);
      setBudgets(data.budgets ?? []);
      setStatus("ok");
    } catch {
      if (isCurrent()) {
        setDataIdentity(`${expectedSubject}:${expectedEpoch}`);
        setStatus("error");
      }
    }
  }, [authorityEpoch, currentSubject]);

  useEffect(() => {
    void load();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [load]);

  const visibleStatus = dataIdentity === currentIdentity ? status : "loading";
  const visibleInsights = dataIdentity === currentIdentity ? insights : [];
  const visibleBudgets = dataIdentity === currentIdentity ? budgets : [];

  return (
    <Card>
      <h2 className="sec">
        Budget Intelligence
        <span className="rule" />
        <span className="count">Plaid · This month</span>
      </h2>

      {visibleStatus === "loading" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)" }}>
          Analyzing spending…
        </p>
      )}
      {visibleStatus === "no-plaid" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
          Add PLAID_CLIENT_ID and PLAID_SECRET in Vercel to see live budget intelligence.
        </p>
      )}
      {visibleStatus === "no-account" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
          Link a bank account to see budget insights.
        </p>
      )}
      {visibleStatus === "error" && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--clay)" }}>
          Could not load budget data. Try again later.
        </p>
      )}

      {visibleStatus === "ok" && (
        <>
          <div style={{ marginTop: 10 }}>
            {visibleInsights.map((t) => (
              <div key={t.title} className="txn">
                <div className="txn-ic" style={t.icColor ? { color: t.icColor } : undefined}>
                  {t.ic}
                </div>
                <div className="txn-b">
                  <div className="txn-t">{t.title}</div>
                  <div className="txn-m">{t.meta}</div>
                </div>
                <div className={`txn-v${t.up ? " up" : ""}`}>{t.value}</div>
              </div>
            ))}
          </div>
          {visibleBudgets.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {visibleBudgets.map((b) => (
                <div key={b.label} className="budgetbar">
                  <div className="bl">
                    <span>{b.label}</span>
                    <span className="bv">{b.spent}</span>
                  </div>
                  <div className="track">
                    <div className={b.cls} style={{ width: `${Math.min(b.pct, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
