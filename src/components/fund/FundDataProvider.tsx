"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// FUND-1: shared fund data store. Holdings and liabilities were each fetched
// independently by 3–5 subroute modules (Investing, Net Worth, Overview,
// Cashflow, Liabilities), so navigating between Fund subroutes re-fetched the
// same data every time. This provider — mounted once in fund/layout.tsx, which
// persists across client-side subroute navigation — fetches each dataset once
// and shares it. Editor modules call the exposed refresh() after mutating so
// every subroute stays consistent without redundant network round-trips.

export type Holding = { id: string; symbol: string; name: string; shares: number; cost_basis: number; source: string; retrieved_at?: string | null };
export type AggregatedHolding = { symbol: string; name: string; shares: number; cost_basis: number; sources: string[]; retrieved_at?: string | null };
export type Liability = {
  id: string;
  name: string;
  kind: string;
  balance: number;
  apr: number | null;
  minimum_payment: number | null;
  due_date: string | null;
};
// Bank-linked liabilities from the §10 Plaid adapter (/api/plaid/liabilities) —
// provenance-aware, so each carries a retrieved_at for a FreshnessBadge, unlike
// manually-tracked liabilities.
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
  refreshPlaidLiabilities: () => Promise<void>;
};

const FundDataContext = createContext<FundData | null>(null);

export function useFundData(): FundData {
  const ctx = useContext(FundDataContext);
  if (!ctx) throw new Error("useFundData must be used within a FundDataProvider (mounted in fund/layout.tsx)");
  return ctx;
}

export function FundDataProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<Holding[]>([]);
  const [aggregated, setAggregated] = useState<AggregatedHolding[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [holdingsError, setHoldingsError] = useState(false);
  const [signedIn, setSignedIn] = useState(true);

  const [liabilities, setLiabilities] = useState<Liability[]>([]);
  const [liabilitiesLoading, setLiabilitiesLoading] = useState(true);
  const [liabilitiesError, setLiabilitiesError] = useState(false);

  const [plaidLiabilities, setPlaidLiabilities] = useState<PlaidLiability[]>([]);

  const refreshHoldings = useCallback(async () => {
    setHoldingsLoading(true);
    try {
      const res = await fetch("/api/fund/holdings");
      setSignedIn(res.status !== 401);
      const data = (await res.json().catch(() => ({}))) as { rows?: Holding[]; aggregated?: AggregatedHolding[] };
      setRows(data.rows ?? []);
      setAggregated(data.aggregated ?? []);
      setHoldingsError(!res.ok && res.status !== 401);
    } catch {
      setHoldingsError(true);
    } finally {
      setHoldingsLoading(false);
    }
  }, []);

  const refreshLiabilities = useCallback(async () => {
    setLiabilitiesLoading(true);
    try {
      const res = await fetch("/api/fund/liabilities");
      const data = (await res.json().catch(() => ({}))) as { liabilities?: Liability[] };
      setLiabilities(data.liabilities ?? []);
      setLiabilitiesError(!res.ok);
    } catch {
      setLiabilitiesError(true);
    } finally {
      setLiabilitiesLoading(false);
    }
  }, []);

  const refreshPlaidLiabilities = useCallback(async () => {
    try {
      const res = await fetch("/api/plaid/liabilities");
      // The adapter returns domain Liabilities with provenance nested; flatten
      // retrievedAt up for the badge. Non-ok / unlinked → empty (soft failure).
      const data = (await res.json().catch(() => ({}))) as {
        liabilities?: Array<{
          accountId: string; type: string; name: string | null;
          balanceCurrent: number | null; currency: string; nextPaymentDueDate: string | null;
          provenance?: { retrievedAt?: string | null };
        }>;
      };
      setPlaidLiabilities(
        res.ok
          ? (data.liabilities ?? []).map((l) => ({
              accountId: l.accountId,
              type: l.type,
              name: l.name,
              balanceCurrent: l.balanceCurrent,
              currency: l.currency,
              nextPaymentDueDate: l.nextPaymentDueDate,
              retrievedAt: l.provenance?.retrievedAt ?? null,
            }))
          : [],
      );
    } catch {
      setPlaidLiabilities([]);
    }
  }, []);

  useEffect(() => {
    void refreshHoldings();
    void refreshLiabilities();
    void refreshPlaidLiabilities();
  }, [refreshHoldings, refreshLiabilities, refreshPlaidLiabilities]);

  return (
    <FundDataContext.Provider
      value={{
        rows,
        aggregated,
        holdingsLoading,
        holdingsError,
        signedIn,
        refreshHoldings,
        liabilities,
        liabilitiesLoading,
        liabilitiesError,
        refreshLiabilities,
        plaidLiabilities,
        refreshPlaidLiabilities,
      }}
    >
      {children}
    </FundDataContext.Provider>
  );
}
