"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// FUND-1: shared fund data store. Holdings and liabilities were each fetched
// independently by 3–5 subroute modules (Investing, Net Worth, Overview,
// Cashflow, Liabilities), so navigating between Fund subroutes re-fetched the
// same data every time. This provider — mounted once in fund/layout.tsx, which
// persists across client-side subroute navigation — fetches each dataset once
// and shares it. Editor modules call the exposed refresh() after mutating so
// every subroute stays consistent without redundant network round-trips.

export type Holding = { id: string; symbol: string; name: string; shares: number; cost_basis: number; source: string };
export type AggregatedHolding = {
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  sources: string[];
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

  useEffect(() => {
    void refreshHoldings();
    void refreshLiabilities();
  }, [refreshHoldings, refreshLiabilities]);

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
      }}
    >
      {children}
    </FundDataContext.Provider>
  );
}
