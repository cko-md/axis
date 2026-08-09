"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { scaledUnitsToDecimalString } from "@/lib/fund/financialTruth";

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
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [recentIntents, setRecentIntents] = useState<IntentSummary[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const retryIdentity = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const response = await fetch("/api/brokerage/orders", { cache: "no-store" }).catch(() => null);
      if (!alive) return;
      if (!response?.ok) {
        setHistoryError(true);
        return;
      }
      const data = await response.json().catch(() => null) as { intents?: unknown } | null;
      setRecentIntents(Array.isArray(data?.intents) ? data.intents.slice(0, 3) as IntentSummary[] : []);
    })();
    return () => { alive = false; };
  }, []);

  async function saveIntent(side: "buy" | "sell") {
    const sym = symbol.trim().toUpperCase();
    const qty = shares.trim();
    const referencePrice = price.trim();
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
    const identity = retryIdentity.current?.fingerprint === fingerprint
      ? retryIdentity.current
      : { fingerprint, idempotencyKey: crypto.randomUUID() };
    retryIdentity.current = identity;
    setBusy(true);

    try {
      const response = await fetch("/api/brokerage/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", idempotencyKey: identity.idempotencyKey, order }),
      });
      const data = await response.json().catch(() => ({})) as OrderRouteResponse;
      if (!response.ok || !data.intent || data.submitted !== false || data.intent.status !== "not_submitted") {
        toast(data.message ?? data.error ?? "The intent could not be saved. No order was submitted.", "error", "Order Intent");
        return;
      }

      setRecentIntents((current) => [data.intent as IntentSummary, ...current.filter((row) => row.id !== data.intent?.id)].slice(0, 3));
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
      toast("The network outcome is unknown. Retry to safely resolve the same intent; no execution is being claimed.", "error", "Order Intent");
    } finally {
      setBusy(false);
    }
  }

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
            value={symbol}
            onChange={(event) => setSymbol(event.target.value.toUpperCase())}
            placeholder="Symbol"
            aria-label="Symbol"
            style={{ maxWidth: 96, fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <span className="capt-pill">Shares</span>
          <input
            value={shares}
            onChange={(event) => setShares(event.target.value)}
            placeholder="0"
            inputMode="decimal"
            aria-label="Shares"
            style={{ maxWidth: 70, fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <span className="capt-pill">Reference</span>
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
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
            disabled={busy}
            onClick={() => saveIntent("buy")}
          >
            {busy ? "Saving…" : "Save buy intent"}
          </button>
          <button
            type="button"
            className="sig-go"
            style={{ flex: 1, padding: 9, color: "var(--down)" }}
            disabled={busy}
            onClick={() => saveIntent("sell")}
          >
            {busy ? "Saving…" : "Save sell intent"}
          </button>
        </div>

        <p style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 9, lineHeight: 1.5 }}>
          {brokerageConfigured
            ? "Public credentials are detected, but live submission remains disabled. Saving creates a reviewable intent only."
            : "Saving creates a reviewable intent only. It does not place or simulate a brokerage order."}
        </p>

        {historyError && (
          <p role="status" style={{ fontSize: 11, color: "var(--clay)", marginTop: 10 }}>
            Saved-intent history is temporarily unavailable.
          </p>
        )}
        {recentIntents.length > 0 && (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 9 }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", letterSpacing: ".08em", textTransform: "uppercase" }}>
              Recent intents
            </p>
            {recentIntents.map((intent) => (
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
