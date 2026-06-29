"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { useToast } from "@/components/ui/Toast";

export type BankAccount = { name: string; mask: string | null; subtype: string | null; current: number | null };

const CLIENT_FETCH_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CLIENT_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * Shared Plaid Link + connection-status logic, extracted from the old
 * single-tab FundModule.tsx so every /fund/* sub-page (Overview, Cash Flow,
 * Investing) can show bank-connection state and trigger linking without
 * duplicating the Plaid Link wiring.
 */
export function usePlaidConnection() {
  const { toast } = useToast();
  const [plaidConfigured, setPlaidConfigured] = useState(false);
  const [plaidLinked, setPlaidLinked] = useState(false);
  const [brokerageConfigured, setBrokerageConfigured] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [balanceError, setBalanceError] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const loadBalances = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/plaid/balances", { method: "POST" });
      const data = await res.json();
      if (data?.configured && Array.isArray(data.accounts)) {
        setBankAccounts(data.accounts);
        setBalanceError(false);
      } else if (data?.error) {
        setBalanceError(true);
      }
    } catch {
      setBalanceError(true);
    }
  }, []);

  useEffect(() => {
    Promise.allSettled([
      fetchWithTimeout("/api/plaid/status")
        .then((r) => r.json())
        .then((s: { configured?: boolean; linked?: boolean } | null) => {
          setPlaidConfigured(!!s?.configured);
          setPlaidLinked(!!s?.linked);
          if (s?.linked) loadBalances();
        })
        .catch(() => null),
      fetchWithTimeout("/api/brokerage/status")
        .then((r) => r.json())
        .then((s: { configured?: boolean } | null) => setBrokerageConfigured(!!s?.configured))
        .catch(() => null),
    ]);
  }, [loadBalances]);

  const fetchLinkToken = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/plaid/link", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { link_token?: string };
      if (res.ok && data?.link_token) setLinkToken(data.link_token);
    } catch {
      toast("Plaid Link took too long to start. Try again.", "error", "Plaid");
    }
  }, [toast]);

  const handleSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      setLinking(true);
      try {
        const res = await fetchWithTimeout("/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token: publicToken, institution: metadata.institution?.name ?? null }),
        });
        if (res.ok) {
          toast("Bank linked! Loading balances…", "success", "Plaid");
          setPlaidConfigured(true);
          setPlaidLinked(true);
          void loadBalances();
          setLinkToken(null);
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          toast(err.error ?? "Failed to link bank.", "error", "Plaid");
        }
      } catch {
        toast("Network error linking bank.", "error", "Plaid");
      } finally {
        setLinking(false);
      }
    },
    [toast, loadBalances],
  );

  const { open: openPlaidLink, ready: plaidLinkReady } = usePlaidLink({
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: (err) => {
      if (err) toast("Plaid Link closed.", "warn", "Plaid");
      setLinkToken(null);
    },
  });

  useEffect(() => {
    if (linkToken && plaidLinkReady) openPlaidLink();
  }, [linkToken, plaidLinkReady, openPlaidLink]);

  const connectBank = useCallback(async () => {
    if (linkToken && plaidLinkReady) {
      openPlaidLink();
      return;
    }
    await fetchLinkToken();
  }, [linkToken, plaidLinkReady, openPlaidLink, fetchLinkToken]);

  const cash = bankAccounts.reduce((s, a) => s + (a.current ?? 0), 0);

  return {
    plaidConfigured,
    plaidLinked,
    brokerageConfigured,
    bankAccounts,
    balanceError,
    cash,
    connectBank,
    linking,
    reloadBalances: loadBalances,
  };
}
