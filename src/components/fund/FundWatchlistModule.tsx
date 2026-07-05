"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_WATCHLIST, fmtUsd2, type WatchlistRow } from "@/lib/store/fund-defaults";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { FundResearchExtras } from "@/components/fund/FundResearchExtras";

export function FundWatchlistModule() {
  const { toast } = useToast();
  const [watchlist, setWatchlist] = useState<WatchlistRow[]>(DEFAULT_WATCHLIST);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<Array<{ sym: string; name: string; ex: string }>>([]);
  const [configured, setConfigured] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase.from("fund_watchlist").select("*").eq("user_id", user.id).order("sort_order");
    if (error) {
      toast("Couldn't load watchlist.", "error", "Watchlist");
      return;
    }
    if (data) setWatchlist(data.map((r) => ({ id: r.id, symbol: r.symbol, name: r.name })));
  }, [toast]);

  useEffect(() => {
    void load();
    fetch("/api/massive/status").then((r) => r.json()).then((s) => setConfigured(!!s?.configured)).catch(() => null);
  }, [load]);

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
    const row: WatchlistRow = { symbol: sym, name };
    if (user) {
      const { data, error } = await supabase
        .from("fund_watchlist")
        .insert({ user_id: user.id, symbol: sym, name, sort_order: watchlist.length })
        .select()
        .single();
      if (error) { toast(error.message, "error", "Watchlist"); return; }
      row.id = data?.id;
    }
    setWatchlist((prev) => [...prev, row]);
    toast(`${sym} added to watchlist.`, "success", "Watchlist");
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

  return (
    <div>
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
        <h2 className="sec">Watchlist<span className="rule" /></h2>
        <div className="watch" style={{ marginTop: 12 }}>
          {watchlist.map((w) => (
            <div key={w.symbol} className="wtile" style={{ position: "relative" }}>
              <button type="button" title={`Remove ${w.symbol}`} onClick={() => removeFromWatchlist(w)} style={{ position: "absolute", top: 4, right: 6, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 11 }}>×</button>
              <div className="wsym"><a href={`/fund/position/${w.symbol}`} style={{ color: "inherit" }}>{w.symbol}</a></div>
              <div className="wprice">{w.price ? fmtUsd2(w.price) : "—"}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="divider" />
      <FundResearchExtras />
    </div>
  );
}
