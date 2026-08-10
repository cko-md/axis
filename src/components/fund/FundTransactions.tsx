"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { formatSignedMinorCurrency } from "@/lib/fund/formatMinorCurrency";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type PlaidTxn = {
  id: string;
  name: string;
  category: string;
  amountMinor: number;
  currency: string;
  date: string;
  pending: boolean;
};

const CATEGORY_IC: Record<string, string> = {
  FOOD_AND_DRINK: "🍽️",
  GROCERIES: "🛒",
  TRANSPORTATION: "🚗",
  MEDICAL: "🏥",
  ENTERTAINMENT: "🎬",
  SUBSCRIPTION: "📱",
  RENT_AND_UTILITIES: "🏠",
  TRAVEL: "✈️",
  GENERAL_MERCHANDISE: "🛍️",
  INCOME: "🏦",
};

function fmtDate(iso: string) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function FundTransactions() {
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [txns, setTxns] = useState<PlaidTxn[]>([]);
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
    setTxns([]);
    setStatus("loading");
    setDataIdentity(null);
    if (!expectedSubject) return;
    const isCurrent = () => !controller.signal.aborted
      && generationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    try {
      const res = await subjectBoundFetch(expectedSubject, "/api/plaid/transactions", {
        method: "POST",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const data = await res.json();
      if (!isCurrent()) return;
      setDataIdentity(`${expectedSubject}:${expectedEpoch}`);
      if (!data.configured) { setStatus("no-plaid"); return; }
      if (data.error === "NO_LINKED_ACCOUNT") { setStatus("no-account"); return; }
      if (!res.ok || data.error) { setStatus("error"); return; }
      setTxns(data.transactions ?? []);
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
  const visibleTxns = dataIdentity === currentIdentity ? txns : [];

  return (
    <Card tick>
      <h2 className="sec">
        Recent Transactions
        <span className="rule" />
        <span className="count">Plaid · 30d</span>
      </h2>
      <div style={{ marginTop: 10 }}>
        {visibleStatus === "loading" && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading transactions…</p>
        )}
        {visibleStatus === "no-plaid" && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
            Add PLAID_CLIENT_ID and PLAID_SECRET in Vercel to connect your bank.
          </p>
        )}
        {visibleStatus === "no-account" && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.6 }}>
            No linked bank account — use Plaid Link to connect one.
          </p>
        )}
        {visibleStatus === "error" && (
          <p style={{ fontSize: 12, color: "var(--clay)" }}>
            Could not load transactions. Try again later.
          </p>
        )}
        {visibleStatus === "ok" && visibleTxns.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            No transactions in the last 30 days.
          </p>
        )}
        {visibleStatus === "ok" &&
          visibleTxns.slice(0, 8).map((t) => (
            <div key={t.id} className="txn">
              <div className="txn-ic">{CATEGORY_IC[t.category] ?? "📋"}</div>
              <div className="txn-b">
                <div className="txn-t">
                  {t.name}
                  {t.pending && (
                    <span
                      style={{
                        marginLeft: 5,
                        fontSize: 9,
                        color: "var(--ink-faint)",
                        fontFamily: "var(--mono)",
                        letterSpacing: ".06em",
                      }}
                    >
                      PENDING
                    </span>
                  )}
                </div>
                <div className="txn-m">
                  {t.category.replace(/_/g, " ")} · {fmtDate(t.date)}
                </div>
              </div>
              <div className={`txn-v${t.amountMinor >= 0 ? " up" : ""}`}>
                {formatSignedMinorCurrency(t.amountMinor, t.currency) ?? "Amount unavailable"}
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}
