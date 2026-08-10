"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { scaledUnitsToDecimalString } from "@/lib/fund/financialTruth";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

type IntentSummary = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity_units: number;
  quantity_scale: number;
  reference_price_minor: number | null;
  currency: string;
  status: "not_submitted";
  created_at: string;
};

type OrderRouteResponse = {
  error?: string;
  message?: string;
  submitted?: boolean;
  intent?: IntentSummary;
};

interface Props {
  /** Pre-fill the symbol (e.g. from the selected chart ticker). */
  defaultSymbol?: string;
  /** Whether a brokerage (Public) is connected, for the safety note. */
  brokerageConfigured?: boolean;
}

function displayQuantity(intent: IntentSummary) {
  const exact = scaledUnitsToDecimalString(intent.quantity_units, intent.quantity_scale);
  if (!exact) return "—";
  return exact.includes(".") ? exact.replace(/0+$/, "").replace(/\.$/, "") : exact;
}

/**
 * Saves an immutable order intent for later review. This component never calls
 * a submit boundary and never writes fund_transactions: an intent is not a
 * provider acknowledgement or a verified fill.
 */
export function FundOrderTicket({ defaultSymbol = "", brokerageConfigured }: Props) {
  const { toast } = useToast();
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const historyGenerationRef = useRef(0);
  const historyControllerRef = useRef<AbortController | null>(null);
  const saveGenerationRef = useRef(0);
  const saveControllerRef = useRef<AbortController | null>(null);
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [recentIntents, setRecentIntents] = useState<IntentSummary[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [draftIdentity, setDraftIdentity] = useState<string | null>(currentIdentity);
  const [historyIdentity, setHistoryIdentity] = useState<string | null>(null);
  const [saveIdentity, setSaveIdentity] = useState<string | null>(null);
  const retryIdentity = useRef<{ subject: string; epoch: number; fingerprint: string; idempotencyKey: string } | null>(null);

  useEffect(() => {
    const generation = ++historyGenerationRef.current;
    historyControllerRef.current?.abort();
    ++saveGenerationRef.current;
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const controller = new AbortController();
    historyControllerRef.current = controller;
    setRecentIntents([]);
    setHistoryError(false);
    setHistoryIdentity(null);
    setSaveIdentity(null);
    setBusy(false);
    setSymbol(defaultSymbol);
    setShares("");
    setPrice("");
    setDraftIdentity(expectedSubject ? `${expectedSubject}:${expectedEpoch}` : null);
    retryIdentity.current = null;
    if (!expectedSubject) return () => controller.abort();
    const isCurrent = () =>
      !controller.signal.aborted
      && historyGenerationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    void (async () => {
      const response = await subjectBoundFetch(expectedSubject, "/api/brokerage/orders", {
        signal: controller.signal,
      }).catch(() => null);
      if (!isCurrent()) return;
      if (!response?.ok) {
        setHistoryError(true);
        setHistoryIdentity(`${expectedSubject}:${expectedEpoch}`);
        return;
      }
      const data = await response.json().catch(() => null) as { intents?: unknown } | null;
      if (!isCurrent()) return;
      setRecentIntents(Array.isArray(data?.intents) ? data.intents.slice(0, 3) as IntentSummary[] : []);
      setHistoryIdentity(`${expectedSubject}:${expectedEpoch}`);
    })();
    return () => {
      controller.abort();
      if (historyControllerRef.current === controller) historyControllerRef.current = null;
    };
  }, [authorityEpoch, currentSubject, defaultSymbol]);

  async function saveIntent(side: "buy" | "sell") {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    if (!expectedSubject) {
      toast("Sign in again before saving an intent.", "error", "Order Intent");
      return;
    }
    const saveGeneration = ++saveGenerationRef.current;
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted
      && saveGenerationRef.current === saveGeneration
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    const ownsDraft = draftIdentity === currentIdentity;
    const sym = (ownsDraft ? symbol : defaultSymbol).trim().toUpperCase();
    const qty = (ownsDraft ? shares : "").trim();
    const referencePrice = (ownsDraft ? price : "").trim();
    if (!sym) {
      toast("Enter a symbol first.", "warn", "Order Intent");
      return;
    }
    if (!/^\d+(?:\.\d{1,6})?$/.test(qty) || Number(qty) <= 0) {
      toast("Enter a positive share quantity with at most six decimal places.", "warn", "Order Intent");
      return;
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(referencePrice) || Number(referencePrice) < 0) {
      toast("Enter a non-negative reference price in dollars and cents.", "warn", "Order Intent");
      return;
    }

    const order = {
      symbol: sym,
      side,
      quantity: qty,
      type: "market",
      referencePrice,
      currency: "USD",
    } as const;
    const fingerprint = JSON.stringify(order);
    const identity = retryIdentity.current?.subject === expectedSubject
      && retryIdentity.current.epoch === expectedEpoch
      && retryIdentity.current.fingerprint === fingerprint
      ? retryIdentity.current
      : { subject: expectedSubject, epoch: expectedEpoch, fingerprint, idempotencyKey: crypto.randomUUID() };
    retryIdentity.current = identity;
    setBusy(true);
    setSaveIdentity(`${expectedSubject}:${expectedEpoch}`);

    try {
      const response = await subjectBoundFetch(expectedSubject, "/api/brokerage/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", idempotencyKey: identity.idempotencyKey, order }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const data = await response.json().catch(() => ({})) as OrderRouteResponse;
      if (!isCurrent()) return;
      if (!response.ok || !data.intent || data.submitted !== false || data.intent.status !== "not_submitted") {
        toast(data.message ?? data.error ?? "The intent could not be saved. No order was submitted.", "error", "Order Intent");
        return;
      }

      setRecentIntents((current) => [data.intent as IntentSummary, ...current.filter((row) => row.id !== data.intent?.id)].slice(0, 3));
      ++historyGenerationRef.current;
      historyControllerRef.current?.abort();
      historyControllerRef.current = null;
      setHistoryIdentity(`${expectedSubject}:${expectedEpoch}`);
      setHistoryError(false);
      retryIdentity.current = null;
      setShares("");
      setPrice("");
      toast(
        `${side === "buy" ? "Buy" : "Sell"} intent saved for ${qty} ${sym}. No brokerage order was submitted.`,
        "success",
        "Order Intent",
      );
    } catch {
      if (isCurrent()) {
        toast("The network outcome is unknown. Retry to safely resolve the same intent; no execution is being claimed.", "error", "Order Intent");
      }
    } finally {
      if (isCurrent()) setBusy(false);
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
    }
  }

  const ownsDraft = draftIdentity === currentIdentity;
  const visibleSymbol = ownsDraft ? symbol : defaultSymbol;
  const visibleShares = ownsDraft ? shares : "";
  const visiblePrice = ownsDraft ? price : "";
  const visibleBusy = saveIdentity === currentIdentity && busy;
  const visibleHistoryError = historyIdentity === currentIdentity && historyError;
  const visibleRecentIntents = historyIdentity === currentIdentity ? recentIntents : [];

  const claimDraft = () => {
    if (draftIdentity === currentIdentity) return;
    setDraftIdentity(currentIdentity);
    setSymbol(defaultSymbol);
    setShares("");
    setPrice("");
    retryIdentity.current = null;
  };

  return (
    <div>
      <Card>
        <h2 className="sec">
          Order Intent
          <span className="rule" />
          <span className="count">Not submitted</span>
        </h2>

        <div className="capture" style={{ margin: "12px 0 0" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 17l6-6 4 4 8-8" />
            <path d="M21 7v6h-6" />
          </svg>
          <input
            value={visibleSymbol}
            onChange={(event) => {
              claimDraft();
              setSymbol(event.target.value.toUpperCase());
            }}
            placeholder="Symbol"
            aria-label="Symbol"
            style={{ maxWidth: 96, fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <span className="capt-pill">Shares</span>
          <input
            value={visibleShares}
            onChange={(event) => {
              claimDraft();
              setShares(event.target.value);
            }}
            placeholder="0"
            inputMode="decimal"
            aria-label="Shares"
            style={{ maxWidth: 70, fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <span className="capt-pill">Reference</span>
          <input
            value={visiblePrice}
            onChange={(event) => {
              claimDraft();
              setPrice(event.target.value);
            }}
            placeholder="0.00"
            inputMode="decimal"
            aria-label="Reference price per share"
            style={{ maxWidth: 80, fontFamily: "var(--mono)", fontSize: 12 }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            type="button"
            className="sig-go"
            style={{ flex: 1, padding: 9, color: "var(--up)" }}
            disabled={visibleBusy}
            onClick={() => saveIntent("buy")}
          >
            {visibleBusy ? "Saving…" : "Save buy intent"}
          </button>
          <button
            type="button"
            className="sig-go"
            style={{ flex: 1, padding: 9, color: "var(--down)" }}
            disabled={visibleBusy}
            onClick={() => saveIntent("sell")}
          >
            {visibleBusy ? "Saving…" : "Save sell intent"}
          </button>
        </div>

        <p style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 9, lineHeight: 1.5 }}>
          {brokerageConfigured
            ? "Public credentials are detected, but live submission remains disabled. Saving creates a reviewable intent only."
            : "Saving creates a reviewable intent only. It does not place or simulate a brokerage order."}
        </p>

        {visibleHistoryError && (
          <p role="status" style={{ fontSize: 11, color: "var(--clay)", marginTop: 10 }}>
            Saved-intent history is temporarily unavailable.
          </p>
        )}
        {visibleRecentIntents.length > 0 && (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 9 }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", letterSpacing: ".08em", textTransform: "uppercase" }}>
              Recent intents
            </p>
            {visibleRecentIntents.map((intent) => (
              <div key={intent.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 7, fontSize: 11 }}>
                <span>{intent.side === "buy" ? "Buy" : "Sell"} {displayQuantity(intent)} {intent.symbol}</span>
                <span style={{ color: "var(--ink-faint)", fontFamily: "var(--mono)", fontSize: 9.5 }}>NOT SUBMITTED</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
