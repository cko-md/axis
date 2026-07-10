"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_WATCHLIST, fmtUsd2, type WatchlistRow } from "@/lib/store/fund-defaults";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { FundResearchExtras } from "@/components/fund/FundResearchExtras";

type QuoteMap = Record<string, { price: number; chg: number }>;

export function FundWatchlistModule() {
  const { toast } = useToast();
  const [watchlist, setWatchlist] = useState<WatchlistRow[]>(DEFAULT_WATCHLIST);
  const [quotes, setQuotes] = useState<QuoteMap>({});
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<Array<{ sym: string; name: string; ex: string }>>([]);
  const [configured, setConfigured] = useState(false);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshQuotes = useCallback(async (symbols: string[]) => {
    if (!symbols.length) {
      setQuotes({});
      return;
    }
    if (!configured) {
      setQuotes({});
      setQuotesError("Set POLYGON_API_KEY to load live quotes.");
      return;
    }
    setQuotesLoading(true);
    setQuotesError(null);
    try {
      const results = await Promise.all(
        symbols.map(async (sym) => {
          const res = await fetch(`/api/massive/quote?symbol=${encodeURIComponent(sym)}`);
          if (!res.ok) return null;
          const data = (await res.json()) as { price?: number; chg?: number };
          if (typeof data.price !== "number") return null;
          return { sym, price: data.price, chg: data.chg ?? 0 };
        }),
      );
      const next: QuoteMap = {};
      for (const row of results) {
        if (row) next[row.sym] = { price: row.price, chg: row.chg };
      }
      setQuotes(next);
      if (results.every((r) => r === null)) {
        setQuotesError("Quotes could not be loaded right now.");
      }
    } catch {
      setQuotesError("Quotes could not be loaded right now.");
    } finally {
      setQuotesLoading(false);
    }
  }, [configured]);

  const load = useCallback(async () => {
    setAuthLoading(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    setSignedIn(!!user);
    if (!user) {
      setWatchlist([]);
      setLoadError(null);
      setAuthLoading(false);
      return;
    }
    const { data, error } = await supabase.from("fund_watchlist").select("*").eq("user_id", user.id).order("sort_order");
    if (error) {
      setLoadError("Couldn't load watchlist.");
      toast("Couldn't load watchlist.", "error", "Watchlist");
      setAuthLoading(false);
      return;
    }
    setLoadError(null);
    const rows = (data ?? []).map((r) => ({ id: r.id, symbol: r.symbol, name: r.name }));
    setWatchlist(rows);
    setAuthLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
    fetch("/api/massive/status").then((r) => r.json()).then((s) => setConfigured(!!s?.configured)).catch(() => null);
  }, [load]);

  useEffect(() => {
    if (signedIn && watchlist.length > 0) {
      void refreshQuotes(watchlist.map((w) => w.symbol));
    }
  }, [configured, signedIn, watchlist, refreshQuotes]);

  async function runSearch() {
    if (!searchQ.trim()) return;
    if (!configured) { toast("API key required for ticker search.", "warn", "Watchlist"); return; }
    const res = await fetch(`/api/massive/search?q=${encodeURIComponent(searchQ)}`);
    if (!res.ok) { toast("Search failed", "error", "Watchlist"); return; }
    const data = await res.json();
    setSearchHits(data.results ?? []);
  }

  async function addToWatchlist(sym: string, name: string) {
    if (watchlist.some((w) => w.symbol === sym)) {
      toast(`${sym} is already on the watchlist.`, "warn", "Watchlist");
      return;
    }
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast("Sign in to save your watchlist.", "warn", "Watchlist");
      return;
    }
    const row: WatchlistRow = { symbol: sym, name };
    const { data, error } = await supabase
      .from("fund_watchlist")
      .insert({ user_id: user.id, symbol: sym, name, sort_order: watchlist.length })
      .select()
      .single();
    if (error) { toast(error.message, "error", "Watchlist"); return; }
    row.id = data?.id;
    setWatchlist((prev) => [...prev, row]);
    toast(`${sym} added to watchlist.`, "success", "Watchlist");
    void refreshQuotes([...watchlist.map((w) => w.symbol), sym]);
  }

  async function removeFromWatchlist(row: WatchlistRow) {
    if (row.id) {
      const supabase = createClient();
      const { error } = await supabase.from("fund_watchlist").delete().eq("id", row.id);
      if (error) {
        toast(error.message || "Couldn't remove ticker.", "error", "Watchlist");
        return;
      }
    }
    setWatchlist((prev) => prev.filter((w) => w.symbol !== row.symbol));
    toast(`${row.symbol} removed from watchlist.`, "info", "Watchlist");
  }

  if (authLoading) {
    return (
      <div>
        <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: 0 }}>Loading watchlist…</p>
        <div className="divider" />
        <FundResearchExtras />
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div>
        <StatusCallout kind="info" title="Sign in to use Watchlist">
          Track tickers with live quotes when Polygon is configured.{" "}
          <Link href="/login" className="feed-manage" style={{ textDecoration: "none" }}>Sign in →</Link>
        </StatusCallout>
        <div className="divider" />
        <FundResearchExtras />
      </div>
    );
  }

  return (
    <div>
      {loadError && (
        <StatusCallout kind="error" title="Watchlist unavailable">
          {loadError}{" "}
          <button type="button" className="feed-manage" onClick={() => void load()}>Retry</button>
        </StatusCallout>
      )}
      {!configured && (
        <StatusCallout kind="info" title="Market data not configured">
          Set POLYGON_API_KEY to enable ticker search and live quotes.
        </StatusCallout>
      )}
      <Card tick>
        <h2 className="sec">Ticker search<span className="rule" /><span className="count">Massive</span></h2>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder="Search tickers — NVDA, Apple…"
            style={{ flex: 1, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 6, padding: "8px 11px", color: "var(--ink)", fontFamily: "var(--mono)", fontSize: 11, outline: "none" }}
          />
          <Button variant="primary" onClick={runSearch}>Search</Button>
        </div>
        <div style={{ marginTop: 10, maxHeight: 180, overflowY: "auto" }}>
          {searchHits.map((hit) => (
            <button
              key={hit.sym}
              type="button"
              style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 7, marginBottom: 6, cursor: "pointer", fontSize: 12, background: "transparent", color: "var(--ink)", textAlign: "left" }}
              onClick={() => addToWatchlist(hit.sym, hit.name)}
            >
              <span><b>{hit.sym}</b> · {hit.name}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)" }}>{hit.ex}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="divider" />
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 className="sec" style={{ margin: 0 }}>Watchlist<span className="rule" /></h2>
          <button
            type="button"
            className="feed-manage"
            onClick={() => void refreshQuotes(watchlist.map((w) => w.symbol))}
            disabled={quotesLoading || watchlist.length === 0}
          >
            {quotesLoading ? "Refreshing…" : "Refresh quotes"}
          </button>
        </div>
        {quotesError && (
          <p style={{ fontSize: 10.5, color: "var(--clay)", fontFamily: "var(--mono)", marginTop: 8 }}>{quotesError}</p>
        )}
        <div className="watch" style={{ marginTop: 12 }}>
          {watchlist.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: 0 }}>No tickers yet — search above to add symbols.</p>
          ) : watchlist.map((w) => {
            const q = quotes[w.symbol];
            return (
              <div key={w.symbol} className="wtile" style={{ position: "relative" }}>
                <button type="button" title={`Remove ${w.symbol}`} onClick={() => removeFromWatchlist(w)} style={{ position: "absolute", top: 4, right: 6, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 11 }}>×</button>
                <div className="wsym"><a href={`/fund/position/${w.symbol}`} style={{ color: "inherit" }}>{w.symbol}</a></div>
                <div className="wprice">{typeof q?.price === "number" ? fmtUsd2(q.price) : quotesLoading ? "…" : "—"}</div>
                {typeof q?.chg === "number" && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: q.chg >= 0 ? "var(--up)" : "var(--down)" }}>
                    {q.chg >= 0 ? "+" : ""}{q.chg.toFixed(2)}%
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="divider" />
      <FundResearchExtras />
    </div>
  );
}
