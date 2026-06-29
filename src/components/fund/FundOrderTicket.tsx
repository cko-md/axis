"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import type { TransactionRow } from "@/lib/store/fund-defaults";

interface Props {
  /** Pre-fill the symbol (e.g. from the selected chart ticker). */
  defaultSymbol?: string;
  /** Called with the new transaction after a successful capture. */
  onLogged?: (txn: TransactionRow) => void;
  /** Whether a brokerage (Public) is connected, for the routing note. */
  brokerageConfigured?: boolean;
}

/**
 * Order ticket built on the .capture (order-ticket) motif. Logs buys/sells to
 * fund_transactions and routes through /api/brokerage/order, which no-ops
 * cleanly to "log only" when no brokerage key is configured.
 */
export function FundOrderTicket({ defaultSymbol = "", onLogged, brokerageConfigured }: Props) {
  const { toast } = useToast();
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(side: "buy" | "sell") {
    const sym = symbol.trim().toUpperCase();
    const qty = parseFloat(shares);
    const px = parseFloat(price);
    if (!sym) {
      toast("Enter a symbol first.", "warn", "Order Ticket");
      return;
    }
    if (!(qty > 0) || !(px > 0)) {
      toast("Enter share quantity and a price above zero.", "warn", "Order Ticket");
      return;
    }

    setBusy(true);
    const gross = qty * px;
    const amount = side === "buy" ? -gross : gross;

    // 1. Route through brokerage proxy (degrades to local-log without keys)
    let routeMsg = "";
    try {
      const res = await fetch("/api/brokerage/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, side, quantity: qty }),
      });
      const data = await res.json().catch(() => ({}));
      routeMsg = data?.message ?? "";
    } catch {
      // network issue — still record the intent locally below
    }

    // 2. Persist to the ledger
    const txn: TransactionRow = {
      kind: side,
      symbol: sym,
      name: sym,
      shares: qty,
      price: px,
      amount,
      source: brokerageConfigured ? "public" : "manual",
      executed_at: new Date().toISOString(),
    };

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data, error } = await supabase
          .from("fund_transactions")
          .insert({
            user_id: user.id,
            kind: txn.kind,
            symbol: txn.symbol,
            name: txn.name,
            shares: txn.shares,
            price: txn.price,
            amount: txn.amount,
            source: txn.source,
            executed_at: txn.executed_at,
          })
          .select()
          .single();
        if (error) {
          toast(error.message, "error", "Order Ticket");
          setBusy(false);
          return;
        }
        txn.id = data?.id;
      }
    } catch {
      // signed-out: keep the local row only
    }

    onLogged?.(txn);
    toast(
      `${side === "buy" ? "Bought" : "Sold"} ${qty} ${sym} @ $${px.toFixed(2)}. ${routeMsg || "Logged to ledger."}`,
      "success",
      "Order Ticket",
    );
    setShares("");
    setPrice("");
    setBusy(false);
  }

  return (
    <div>
      <Card>
        <h2 className="sec">
          Order Ticket
          <span className="rule" />
          <span className="count">{brokerageConfigured ? "Public" : "Ledger"}</span>
        </h2>

        <div className="capture" style={{ margin: "12px 0 0" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 17l6-6 4 4 8-8" />
            <path d="M21 7v6h-6" />
          </svg>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="Symbol"
            aria-label="Symbol"
            style={{ maxWidth: 96, fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <span className="capt-pill">Shares</span>
          <input
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            aria-label="Shares"
            style={{ maxWidth: 70, fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <span className="capt-pill">Price</span>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            aria-label="Price per share"
            style={{ maxWidth: 80, fontFamily: "var(--mono)", fontSize: 12 }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            type="button"
            className="sig-go"
            style={{ flex: 1, padding: 9, color: "var(--up)" }}
            disabled={busy}
            onClick={() => submit("buy")}
          >
            {busy ? "…" : "Buy"}
          </button>
          <button
            type="button"
            className="sig-go"
            style={{ flex: 1, padding: 9, color: "var(--down)" }}
            disabled={busy}
            onClick={() => submit("sell")}
          >
            {busy ? "…" : "Sell"}
          </button>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 9, lineHeight: 1.5 }}>
          {brokerageConfigured
            ? "Routes through Public.com; every fill is captured to your ledger."
            : "No brokerage connected — captures to your ledger only. Add APP_PUBLIC_API_KEY to route live."}
        </div>
      </Card>
    </div>
  );
}
