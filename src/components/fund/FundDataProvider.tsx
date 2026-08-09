"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";

// FUND-1: shared fund data store. Holdings and liabilities were each fetched
// independently by 3–5 subroute modules (Investing, Net Worth, Overview,
// Cashflow, Liabilities), so navigating between Fund subroutes re-fetched the
// same data every time. This provider — mounted once in fund/layout.tsx, which
// persists across client-side subroute navigation — fetches each dataset once
// and shares it. Editor modules call the exposed refresh() after mutating so
// every subroute stays consistent without redundant network round-trips.

export type Holding = {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  source: string;
  authority?: "provider" | "manual";
  retrieved_at?: string | null;
};
export type AggregatedHolding = {
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number | null;
  sources: string[];
  currencies?: string[];
  /** Shared currency for this symbol, or null when constituent rows differ. */
  currency?: string | null;
  total_reason?: "mixed_currency_without_fx" | "invalid_amount" | null;
  /** Oldest constituent retrieved_at (conservative freshness anchor). */
  retrieved_at?: string | null;
  /** Cross-source reconciliation state; null until the symbol has ≥2 sources. */
  reconciliation_state?: "matched" | "partial" | "conflicting" | "missing" | "stale" | "pending" | null;
};
export type Liability = {
  id: string;
  name: string;
  kind: string;
  balance: number;
  apr: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  currency?: string | null;
  source?: string;
  authority?: "provider" | "manual";
  retrieved_at?: string | null;
};
// Provider liabilities are read from the same persisted source of truth as
// manual liabilities. Live provider refresh is owned by the bounded finance
// reconciler and never triggered implicitly by mounting a client layout.
export type PlaidLiability = {
  accountId: string;
  type: string;
  name: string | null;
  balanceCurrent: number | null;
  currency: string;
  nextPaymentDueDate: string | null;
  retrievedAt: string | null;
};

type FundData = {
  rows: Holding[];
  aggregated: AggregatedHolding[];
  holdingsLoading: boolean;
  holdingsError: boolean;
  /** false only when the holdings fetch returned 401 — used to gate signed-out UI. */
  signedIn: boolean;
  refreshHoldings: () => Promise<void>;
  liabilities: Liability[];
  liabilitiesLoading: boolean;
  liabilitiesError: boolean;
  refreshLiabilities: () => Promise<void>;
  /** Bank-linked (Plaid) liabilities with provenance/freshness. Empty when unlinked. */
  plaidLiabilities: PlaidLiability[];
  plaidLiabilitiesState: "loading" | "ready" | "unavailable";
  plaidLiabilitiesConnected: boolean | null;
  refreshPlaidLiabilities: () => Promise<void>;
};

const FundDataContext = createContext<FundData | null>(null);

export function useFundData(): FundData {
  const ctx = useContext(FundDataContext);
  if (!ctx) throw new Error("useFundData must be used within a FundDataProvider (mounted in fund/layout.tsx)");
  return ctx;
}

export function FundDataProvider({ children }: { children: ReactNode }) {
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const holdingsRequestRef = useRef(0);
  const liabilitiesRequestRef = useRef(0);
  const [rows, setRows] = useState<Holding[]>([]);
  const [aggregated, setAggregated] = useState<AggregatedHolding[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [holdingsError, setHoldingsError] = useState(false);
  const [signedIn, setSignedIn] = useState(true);
  const [holdingsSubject, setHoldingsSubject] = useState<string | null>(null);

  const [liabilities, setLiabilities] = useState<Liability[]>([]);
  const [liabilitiesLoading, setLiabilitiesLoading] = useState(true);
  const [liabilitiesError, setLiabilitiesError] = useState(false);
  const [liabilitiesSubject, setLiabilitiesSubject] = useState<string | null>(null);

  const [plaidLiabilities, setPlaidLiabilities] = useState<PlaidLiability[]>([]);
  const [plaidLiabilitiesState, setPlaidLiabilitiesState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [plaidLiabilitiesConnected, setPlaidLiabilitiesConnected] = useState<boolean | null>(null);

  const refreshHoldings = useCallback(async () => {
    const requestGeneration = ++holdingsRequestRef.current;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    setHoldingsLoading(true);
    if (!expectedSubject) {
      setRows([]);
      setAggregated([]);
      setHoldingsSubject(null);
      setSignedIn(accountState !== "signed-out");
      setHoldingsLoading(false);
      return;
    }
    const isCurrent = () =>
      holdingsRequestRef.current === requestGeneration
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    try {
      const res = await fetch("/api/fund/holdings", {
        cache: "no-store",
        headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: expectedSubject },
      });
      if (!isCurrent()) return;
      setSignedIn(res.status !== 401);
      const data = (await res.json().catch(() => ({}))) as { rows?: Holding[]; aggregated?: AggregatedHolding[] };
      if (!isCurrent()) return;
      if (!res.ok) {
        if (res.status === 401 || res.status === 409) {
          // Authentication loss is a privacy boundary, not a stale-data case.
          // Never retain a previous subject's financial rows after it.
          setRows([]);
          setAggregated([]);
          setHoldingsSubject(null);
        }
        setHoldingsError(res.status !== 401);
        return;
      }
      setRows(data.rows ?? []);
      setAggregated(data.aggregated ?? []);
      setHoldingsSubject(expectedSubject);
      setHoldingsError(false);
    } catch {
      if (isCurrent()) setHoldingsError(true);
    } finally {
      if (isCurrent()) setHoldingsLoading(false);
    }
  }, [accountState, authorityEpoch, currentSubject]);

  const refreshLiabilities = useCallback(async () => {
    const requestGeneration = ++liabilitiesRequestRef.current;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    setLiabilitiesLoading(true);
    if (!expectedSubject) {
      setLiabilities([]);
      setPlaidLiabilities([]);
      setLiabilitiesSubject(null);
      setPlaidLiabilitiesConnected(null);
      setPlaidLiabilitiesState("unavailable");
      setLiabilitiesLoading(false);
      return;
    }
    const isCurrent = () =>
      liabilitiesRequestRef.current === requestGeneration
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    try {
      const res = await fetch("/api/fund/liabilities", {
        cache: "no-store",
        headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: expectedSubject },
      });
      if (!isCurrent()) return;
      const data = (await res.json().catch(() => ({}))) as {
        liabilities?: Liability[];
        providerAvailability?: Array<{ availability_status?: string; availability_reason?: string | null }>;
      };
      if (!isCurrent()) return;
      if (!res.ok) {
        setLiabilities([]);
        setPlaidLiabilities([]);
        setPlaidLiabilitiesConnected(null);
        setPlaidLiabilitiesState("unavailable");
        setLiabilitiesError(true);
        setLiabilitiesSubject(null);
        return;
      }
      const all = data.liabilities ?? [];
      setLiabilities(all.filter((liability) => liability.authority === "manual"));
      setPlaidLiabilities(
        all
          .filter((liability) => liability.authority === "provider")
          .map((liability) => ({
            accountId: liability.id,
            type: liability.kind,
            name: liability.name,
            balanceCurrent: liability.balance,
            currency: liability.currency ?? "",
            nextPaymentDueDate: liability.due_date,
            retrievedAt: liability.retrieved_at ?? null,
          })),
      );
      const providerAttempts = data.providerAvailability ?? [];
      setPlaidLiabilitiesConnected(
        all.some((liability) => liability.authority === "provider") || providerAttempts.length > 0,
      );
      setPlaidLiabilitiesState(
        providerAttempts.some((attempt) => attempt.availability_status !== "available")
          ? "unavailable"
          : "ready",
      );
      setLiabilitiesError(false);
      setLiabilitiesSubject(expectedSubject);
    } catch {
      if (isCurrent()) {
        setLiabilitiesError(true);
        setPlaidLiabilities([]);
        setLiabilitiesSubject(null);
        setPlaidLiabilitiesConnected(null);
        setPlaidLiabilitiesState("unavailable");
      }
    } finally {
      if (isCurrent()) setLiabilitiesLoading(false);
    }
  }, [authorityEpoch, currentSubject]);

  const refreshPlaidLiabilities = useCallback(async () => {
    setPlaidLiabilitiesState("loading");
    await refreshLiabilities();
  }, [refreshLiabilities]);

  useEffect(() => {
    void refreshHoldings();
    void refreshLiabilities();
    return () => {
      holdingsRequestRef.current += 1;
      liabilitiesRequestRef.current += 1;
    };
  }, [refreshHoldings, refreshLiabilities]);

  const visibleRows = holdingsSubject === currentSubject ? rows : [];
  const visibleAggregated = holdingsSubject === currentSubject ? aggregated : [];
  const visibleLiabilities = liabilitiesSubject === currentSubject ? liabilities : [];
  const visiblePlaidLiabilities = liabilitiesSubject === currentSubject ? plaidLiabilities : [];

  return (
    <FundDataContext.Provider
      value={{
        rows: visibleRows,
        aggregated: visibleAggregated,
        holdingsLoading,
        holdingsError,
        signedIn,
        refreshHoldings,
        liabilities: visibleLiabilities,
        liabilitiesLoading,
        liabilitiesError,
        refreshLiabilities,
        plaidLiabilities: visiblePlaidLiabilities,
        plaidLiabilitiesState,
        plaidLiabilitiesConnected,
        refreshPlaidLiabilities,
      }}
    >
      {children}
    </FundDataContext.Provider>
  );
}
