"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { useToast } from "@/components/ui/Toast";
import { addMinorUnits, minorUnitsToDecimalString } from "@/lib/fund/financialTruth";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

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

async function fetchWithTimeout(subject: string, input: string | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CLIENT_FETCH_TIMEOUT_MS);
  try {
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    return await subjectBoundFetch(subject, input, { ...init, signal });
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
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const statusGenerationRef = useRef(0);
  const balanceGenerationRef = useRef(0);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
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
  const [plaidIdentity, setPlaidIdentity] = useState<string | null>(null);
  const [brokerageIdentity, setBrokerageIdentity] = useState<string | null>(null);
  const [linkTokenIdentity, setLinkTokenIdentity] = useState<string | null>(null);

  const loadBalances = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) return;
    const generation = ++balanceGenerationRef.current;
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted
      && balanceGenerationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    try {
      const res = await fetchWithTimeout(expectedSubject, "/api/plaid/balances", { method: "POST", signal: controller.signal });
      if (!isCurrent()) return;
      const data = await res.json();
      if (!isCurrent()) return;
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
          setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
          return;
        }
        let cashMinor = 0;
        for (const account of cashAccounts) {
          const currency = account.currency;
          if (!currency) {
            setCash(null);
            setCashReason("CASH_CURRENCY_UNAVAILABLE");
            setBalanceError(true);
            setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
            return;
          }
          const minor = account.currentMinor;
          const nextCash = minor === null ? null : addMinorUnits(cashMinor, minor);
          if (nextCash === null) {
            setCash(null);
            setCashMinor(null);
            setCashReason("CASH_AMOUNT_UNAVAILABLE");
            setBalanceError(true);
            setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
            return;
          }
          cashMinor = nextCash;
        }
        if (cashAccounts.length === 0) {
          setCash(null);
          setCashMinor(null);
          setCashReason(accounts.length > 0 ? "ACCOUNT_TYPE_REQUIRES_PARTITION" : "CASH_UNAVAILABLE");
          setBalanceError(true);
        } else if (currencies.size !== 1 || !currencies.has("USD")) {
          setCash(null);
          setCashMinor(null);
          setCashReason("MIXED_CURRENCY_REQUIRES_FX");
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
      if (isCurrent()) setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
    } catch {
      if (isCurrent()) {
        setCash(null);
        setCashMinor(null);
        setBankAccounts([]);
        setCashReason("PLAID_BALANCES_FAILED");
        setBalanceError(true);
        setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
      }
    }
  }, [authorityEpoch, currentSubject]);

  useEffect(() => {
    const generation = ++statusGenerationRef.current;
    ++balanceGenerationRef.current;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const controller = new AbortController();
    setPlaidIdentity(null);
    setBrokerageIdentity(null);
    setPlaidConfigured(false);
    setPlaidLinked(false);
    setPlaidReconnectRequired(false);
    setPlaidRecoveryConnectionIds([]);
    setPlaidStatusState("loading");
    setBrokerageConfigured(false);
    setBrokerageStatusState("loading");
    setBankAccounts([]);
    setCash(null);
    setCashMinor(null);
    setCashReason(null);
    setBalanceError(false);
    setLinkToken(null);
    setLinkTokenIdentity(null);
    setLinking(false);
    if (!expectedSubject) {
      setPlaidIdentity(null);
      setBrokerageIdentity(null);
      return () => controller.abort();
    }
    const isCurrent = () =>
      !controller.signal.aborted
      && statusGenerationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    Promise.allSettled([
      fetchWithTimeout(expectedSubject, "/api/plaid/status", { signal: controller.signal })
        .then(async (r) => {
          if (!isCurrent()) throw new DOMException("stale subject", "AbortError");
          const body = await r.json().catch(() => null);
          if (!isCurrent()) throw new DOMException("stale subject", "AbortError");
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
          if (!isCurrent()) return;
          setPlaidConfigured(!!s?.configured);
          setPlaidLinked(!!s?.linked);
          setPlaidReconnectRequired(!!s?.reconnectRequired);
          setPlaidRecoveryConnectionIds(
            (s?.recoveryConnections ?? [])
              .map((connection) => connection.id)
              .filter((id): id is string => typeof id === "string"),
          );
          setPlaidStatusState("ready");
          setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
          if (s?.reconnectRequired) {
            setCash(null);
            setCashMinor(null);
            setCashReason("PLAID_RECONNECT_REQUIRED");
          }
          if (s?.linked) loadBalances();
        })
        .catch(() => {
          if (!isCurrent()) return;
          setPlaidConfigured(false);
          setPlaidLinked(false);
          setPlaidReconnectRequired(false);
          setPlaidRecoveryConnectionIds([]);
          setPlaidStatusState("unavailable");
          setCash(null);
          setCashMinor(null);
          setCashReason("PLAID_STATUS_UNAVAILABLE");
          setPlaidIdentity(`${expectedSubject}:${expectedEpoch}`);
        }),
      fetchWithTimeout(expectedSubject, "/api/brokerage/status", { signal: controller.signal })
        .then(async (r) => {
          if (!isCurrent()) throw new DOMException("stale subject", "AbortError");
          const body = await r.json().catch(() => null);
          if (!isCurrent()) throw new DOMException("stale subject", "AbortError");
          if (!r.ok) throw new Error("BROKERAGE_STATUS_UNAVAILABLE");
          if (
            !body
            || typeof body !== "object"
            || typeof (body as { configured?: unknown }).configured !== "boolean"
          ) throw new Error("BROKERAGE_STATUS_UNAVAILABLE");
          return body;
        })
        .then((s: { configured?: boolean } | null) => {
          if (!isCurrent()) return;
          setBrokerageConfigured(!!s?.configured);
          setBrokerageStatusState("ready");
          setBrokerageIdentity(`${expectedSubject}:${expectedEpoch}`);
        })
        .catch(() => {
          if (!isCurrent()) return;
          setBrokerageConfigured(false);
          setBrokerageStatusState("unavailable");
          setBrokerageIdentity(`${expectedSubject}:${expectedEpoch}`);
        }),
    ]);
    return () => controller.abort();
  }, [authorityEpoch, currentSubject, loadBalances]);

  const fetchLinkToken = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) return;
    const expectedIdentity = `${expectedSubject}:${expectedEpoch}`;
    try {
      const res = await fetchWithTimeout(expectedSubject, "/api/plaid/link", { method: "POST" });
      if (currentSubjectRef.current !== expectedSubject || authorityEpochRef.current !== expectedEpoch) return;
      const data = (await res.json().catch(() => ({}))) as { link_token?: string };
      if (currentSubjectRef.current !== expectedSubject || authorityEpochRef.current !== expectedEpoch) return;
      if (!res.ok || !data?.link_token) {
        toast("Plaid Link could not start. Try again.", "error", "Plaid");
        return;
      }
      setLinkToken(data.link_token);
      setLinkTokenIdentity(expectedIdentity);
    } catch {
      if (currentSubjectRef.current === expectedSubject && authorityEpochRef.current === expectedEpoch) {
        toast("Plaid Link took too long to start. Try again.", "error", "Plaid");
      }
    }
  }, [authorityEpoch, currentSubject, toast]);

  const handleSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      const expectedSubject = currentSubject;
      const expectedEpoch = authorityEpoch;
      const expectedIdentity = expectedSubject ? `${expectedSubject}:${expectedEpoch}` : null;
      if (!expectedSubject || linkTokenIdentity !== expectedIdentity) return;
      const isCurrent = () =>
        currentSubjectRef.current === expectedSubject
        && authorityEpochRef.current === expectedEpoch;
      setLinking(true);
      try {
        const res = await fetchWithTimeout(expectedSubject, "/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token: publicToken, institution: metadata.institution?.name ?? null }),
        });
        if (!isCurrent()) return;
        if (res.ok) {
          toast("Bank linked! Loading balances…", "success", "Plaid");
          setPlaidConfigured(true);
          setPlaidLinked(true);
          setPlaidReconnectRequired(false);
          setPlaidStatusState("ready");
          setPlaidIdentity(expectedIdentity);
          void loadBalances();
          setLinkToken(null);
          setLinkTokenIdentity(null);
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          if (!isCurrent()) return;
          toast(err.error ?? "Failed to link bank.", "error", "Plaid");
        }
      } catch {
        if (isCurrent()) toast("Network error linking bank.", "error", "Plaid");
      } finally {
        if (isCurrent()) setLinking(false);
      }
    },
    [authorityEpoch, currentSubject, linkTokenIdentity, toast, loadBalances],
  );

  const visibleLinkToken = linkTokenIdentity === currentIdentity ? linkToken : null;

  const { open: openPlaidLink, ready: plaidLinkReady } = usePlaidLink({
    token: visibleLinkToken,
    onSuccess: handleSuccess,
    onExit: (err) => {
      if (linkTokenIdentity === currentIdentity) {
        if (err) toast("Plaid Link closed.", "warn", "Plaid");
        setLinkToken(null);
        setLinkTokenIdentity(null);
      }
    },
  });

  useEffect(() => {
    if (visibleLinkToken && plaidLinkReady) openPlaidLink();
  }, [visibleLinkToken, plaidLinkReady, openPlaidLink]);

  const connectBank = useCallback(async () => {
    if (visibleLinkToken && plaidLinkReady) {
      openPlaidLink();
      return;
    }
    await fetchLinkToken();
  }, [visibleLinkToken, plaidLinkReady, openPlaidLink, fetchLinkToken]);

  const recoverBankConnection = useCallback(async () => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const recoveryIds = plaidIdentity === currentIdentity ? plaidRecoveryConnectionIds : [];
    if (!expectedSubject || recoveryIds.length === 0) {
      toast("Plaid recovery details are unavailable. Refresh and retry.", "error", "Plaid");
      return;
    }
    const isCurrent = () =>
      currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    const confirmed = window.confirm(
      recoveryIds.length === 1
        ? "Disconnect this unverified Plaid connection and start a fresh link?"
        : `Disconnect all ${recoveryIds.length} unverified Plaid connections and start a fresh link?`,
    );
    if (!confirmed) return;
    setLinking(true);
    try {
      for (const connectionId of recoveryIds) {
        const response = await fetchWithTimeout(expectedSubject, "/api/plaid/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        });
        if (!isCurrent()) return;
        if (!response.ok) throw new Error("PLAID_DISCONNECT_FAILED");
      }
      setPlaidReconnectRequired(false);
      setPlaidLinked(false);
      setPlaidRecoveryConnectionIds([]);
      toast("Old Plaid authorization removed. Continue with a fresh link.", "success", "Plaid");
      await fetchLinkToken();
    } catch {
      if (isCurrent()) toast("Plaid recovery could not finish. No new link was created.", "error", "Plaid");
    } finally {
      if (isCurrent()) setLinking(false);
    }
  }, [authorityEpoch, currentIdentity, currentSubject, fetchLinkToken, plaidIdentity, plaidRecoveryConnectionIds, toast]);

  const ownsPlaid = plaidIdentity === currentIdentity;
  const ownsBrokerage = brokerageIdentity === currentIdentity;

  return {
    plaidConfigured: ownsPlaid ? plaidConfigured : false,
    plaidLinked: ownsPlaid ? plaidLinked : false,
    plaidReconnectRequired: ownsPlaid ? plaidReconnectRequired : false,
    brokerageConfigured: ownsBrokerage ? brokerageConfigured : false,
    plaidStatusState: ownsPlaid ? plaidStatusState : "loading",
    brokerageStatusState: ownsBrokerage ? brokerageStatusState : "loading",
    bankAccounts: ownsPlaid ? bankAccounts : [],
    balanceError: ownsPlaid ? balanceError : false,
    cash: ownsPlaid ? cash : null,
    cashMinor: ownsPlaid ? cashMinor : null,
    cashReason: ownsPlaid ? cashReason : null,
    connectBank,
    recoverBankConnection,
    linking: linkTokenIdentity === currentIdentity && linking,
    reloadBalances: loadBalances,
  };
}
