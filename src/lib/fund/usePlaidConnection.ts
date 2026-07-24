"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { useToast } from "@/components/ui/Toast";
import { addMinorUnits, minorUnitsToDecimalString } from "@/lib/fund/financialTruth";

export type BankAccount = {
  connectionId?: string;
  institution?: string | null;
  name: string;
  mask: string | null;
  subtype: string | null;
  type: string | null;
  current: string | null;
  currentMinor: number | null;
  currency: string | null;
};

export type ConnectionStatusState = "loading" | "ready" | "unavailable";

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
  const [plaidReconnectRequired, setPlaidReconnectRequired] = useState(false);
  const [brokerageConfigured, setBrokerageConfigured] = useState(false);
  const [plaidStatusState, setPlaidStatusState] = useState<ConnectionStatusState>("loading");
  const [brokerageStatusState, setBrokerageStatusState] = useState<ConnectionStatusState>("loading");
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [balanceError, setBalanceError] = useState(false);
  const [cash, setCash] = useState<string | null>(null);
  const [cashMinor, setCashMinor] = useState<number | null>(null);
  const [cashReason, setCashReason] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [plaidRecoveryConnectionIds, setPlaidRecoveryConnectionIds] = useState<string[]>([]);

  const loadBalances = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/plaid/balances", { method: "POST" });
      const data = await res.json();
      if (res.ok && data?.configured && data.completeness === "complete" && Array.isArray(data.accounts)) {
        const accounts = data.accounts as BankAccount[];
        setBankAccounts(accounts);
        const cashAccounts = accounts.filter((account) => account.type === "depository");
        const currencies = new Set(cashAccounts.map((account) => account.currency ?? "USD"));
        if (cashAccounts.some((account) => !account.currency)) {
          setCash(null);
          setCashMinor(null);
          setCashReason("CASH_CURRENCY_UNAVAILABLE");
          setBalanceError(true);
          return;
        }
        let cashMinor = 0;
        for (const account of cashAccounts) {
          const currency = account.currency;
          if (!currency) {
            setCash(null);
            setCashReason("CASH_CURRENCY_UNAVAILABLE");
            setBalanceError(true);
            return;
          }
          const minor = account.currentMinor;
          const nextCash = minor === null ? null : addMinorUnits(cashMinor, minor);
          if (nextCash === null) {
            setCash(null);
            setCashMinor(null);
            setCashReason("CASH_AMOUNT_UNAVAILABLE");
            setBalanceError(true);
            return;
          }
          cashMinor = nextCash;
        }
        if (cashAccounts.length === 0 || currencies.size !== 1 || !currencies.has("USD")) {
          setCash(null);
          setCashMinor(null);
          setCashReason(currencies.size !== 1 || !currencies.has("USD") ? "MIXED_CURRENCY_REQUIRES_FX" : "CASH_UNAVAILABLE");
          setBalanceError(true);
        } else {
          setCash(minorUnitsToDecimalString(cashMinor, "USD"));
          setCashMinor(cashMinor);
          setCashReason(null);
          setBalanceError(false);
        }
      } else if (data?.error) {
        setCash(null);
        setCashMinor(null);
        setBankAccounts([]);
        setCashReason(data.error);
        setBalanceError(true);
      } else {
        setCash(null);
        setCashMinor(null);
        setBankAccounts([]);
        setCashReason("PLAID_BALANCES_UNAVAILABLE");
        setBalanceError(true);
      }
    } catch {
      setCash(null);
      setCashMinor(null);
      setBankAccounts([]);
      setCashReason("PLAID_BALANCES_FAILED");
      setBalanceError(true);
    }
  }, []);

  useEffect(() => {
    Promise.allSettled([
      fetchWithTimeout("/api/plaid/status")
        .then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error("PLAID_STATUS_UNAVAILABLE");
          if (
            !body
            || typeof body !== "object"
            || typeof (body as { configured?: unknown }).configured !== "boolean"
            || typeof (body as { linked?: unknown }).linked !== "boolean"
          ) throw new Error("PLAID_STATUS_UNAVAILABLE");
          return body;
        })
        .then((s: {
          configured?: boolean;
          linked?: boolean;
          reconnectRequired?: boolean;
          recoveryConnections?: Array<{ id?: unknown }>;
        } | null) => {
          setPlaidConfigured(!!s?.configured);
          setPlaidLinked(!!s?.linked);
          setPlaidReconnectRequired(!!s?.reconnectRequired);
          setPlaidRecoveryConnectionIds(
            (s?.recoveryConnections ?? [])
              .map((connection) => connection.id)
              .filter((id): id is string => typeof id === "string"),
          );
          setPlaidStatusState("ready");
          if (s?.reconnectRequired) {
            setCash(null);
            setCashMinor(null);
            setCashReason("PLAID_RECONNECT_REQUIRED");
          }
          if (s?.linked) loadBalances();
        })
        .catch(() => {
          setPlaidConfigured(false);
          setPlaidLinked(false);
          setPlaidReconnectRequired(false);
          setPlaidRecoveryConnectionIds([]);
          setPlaidStatusState("unavailable");
          setCash(null);
          setCashMinor(null);
          setCashReason("PLAID_STATUS_UNAVAILABLE");
        }),
      fetchWithTimeout("/api/brokerage/status")
        .then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error("BROKERAGE_STATUS_UNAVAILABLE");
          if (
            !body
            || typeof body !== "object"
            || typeof (body as { configured?: unknown }).configured !== "boolean"
          ) throw new Error("BROKERAGE_STATUS_UNAVAILABLE");
          return body;
        })
        .then((s: { configured?: boolean } | null) => {
          setBrokerageConfigured(!!s?.configured);
          setBrokerageStatusState("ready");
        })
        .catch(() => {
          setBrokerageConfigured(false);
          setBrokerageStatusState("unavailable");
        }),
    ]);
  }, [loadBalances]);

  const fetchLinkToken = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/plaid/link", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { link_token?: string };
      if (!res.ok || !data?.link_token) {
        toast("Plaid Link could not start. Try again.", "error", "Plaid");
        return;
      }
      setLinkToken(data.link_token);
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
          setPlaidReconnectRequired(false);
          setPlaidStatusState("ready");
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

  const recoverBankConnection = useCallback(async () => {
    if (plaidRecoveryConnectionIds.length === 0) {
      toast("Plaid recovery details are unavailable. Refresh and retry.", "error", "Plaid");
      return;
    }
    const confirmed = window.confirm(
      plaidRecoveryConnectionIds.length === 1
        ? "Disconnect this unverified Plaid connection and start a fresh link?"
        : `Disconnect all ${plaidRecoveryConnectionIds.length} unverified Plaid connections and start a fresh link?`,
    );
    if (!confirmed) return;
    setLinking(true);
    try {
      for (const connectionId of plaidRecoveryConnectionIds) {
        const response = await fetchWithTimeout("/api/plaid/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        });
        if (!response.ok) throw new Error("PLAID_DISCONNECT_FAILED");
      }
      setPlaidReconnectRequired(false);
      setPlaidLinked(false);
      setPlaidRecoveryConnectionIds([]);
      toast("Old Plaid authorization removed. Continue with a fresh link.", "success", "Plaid");
      await fetchLinkToken();
    } catch {
      toast("Plaid recovery could not finish. No new link was created.", "error", "Plaid");
    } finally {
      setLinking(false);
    }
  }, [fetchLinkToken, plaidRecoveryConnectionIds, toast]);

  return {
    plaidConfigured,
    plaidLinked,
    plaidReconnectRequired,
    brokerageConfigured,
    plaidStatusState,
    brokerageStatusState,
    bankAccounts,
    balanceError,
    cash,
    cashMinor,
    cashReason,
    connectBank,
    recoverBankConnection,
    linking,
    reloadBalances: loadBalances,
  };
}
