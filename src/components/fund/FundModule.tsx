"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_HOLDINGS,
  DEFAULT_WATCHLIST,
  fmtUsd,
  fmtUsd2,
  holdingGain,
  holdingValue,
  type HoldingRow,
  type WatchlistRow,
} from "@/lib/store/fund-defaults";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { FundBudget } from "@/components/fund/FundBudget";
import { NetWorthChart } from "@/components/fund/NetWorthChart";
import { FundOrderTicket } from "@/components/fund/FundOrderTicket";
import { FundResearchExtras } from "@/components/fund/FundResearchExtras";
import { FundTransactions } from "@/components/fund/FundTransactions";

interface ApiStatus {
  configured: boolean;
  source: string;
  message: string;
}

export function FundModule() {
  const { toast } = useToast();
  const [holdings, setHoldings] = useState<HoldingRow[]>(DEFAULT_HOLDINGS);
  const [watchlist, setWatchlist] = useState<WatchlistRow[]>(DEFAULT_WATCHLIST);
  const [signedIn, setSignedIn] = useState(false);
  const [cash, setCash] = useState(34210);
  const [bankAccounts, setBankAccounts] = useState<
    Array<{ name: string; mask: string | null; subtype: string | null; current: number | null }>
  >([]);
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [plaidConfigured, setPlaidConfigured] = useState(false);
  const [plaidLinked, setPlaidLinked] = useState(false);
  const [brokerageConfigured, setBrokerageConfigured] = useState(false);
  const [live, setLive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSym, setAddSym] = useState("");
  const [addName, setAddName] = useState("");
  const [addShares, setAddShares] = useState("1");
  const [addCost, setAddCost] = useState("0");
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<
    Array<{ sym: string; name: string; ex: string }>
  >([]);
  const [tab, setTab] = useState<"overview" | "portfolio" | "cash" | "research">("overview");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [plaidLinking, setPlaidLinking] = useState(false);

  const invested = holdings.reduce((s, h) => s + holdingValue(h), 0);
  const netWorth = invested + cash;

  const loadData = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setSignedIn(true);
      // Signed-in users never see the demo cash figure — it starts at 0 and is
      // populated only by live Plaid balances once a bank is linked.
      setCash(0);

      const [hRes, wRes] = await Promise.all([
        supabase.from("fund_holdings").select("*").eq("user_id", user.id).order("sort_order"),
        supabase.from("fund_watchlist").select("*").eq("user_id", user.id).order("sort_order"),
      ]);

      // Signed-in users see their real (possibly empty) data, never the demo defaults
      if (hRes.data) {
        setHoldings(
          hRes.data.map((r) => ({
            id: r.id,
            symbol: r.symbol,
            name: r.name,
            shares: Number(r.shares),
            cost_basis: Number(r.cost_basis),
          })),
        );
      }
      if (wRes.data) {
        setWatchlist(
          wRes.data.map((r) => ({
            id: r.id,
            symbol: r.symbol,
            name: r.name,
          })),
        );
      }
    } catch {
      // signed-out demo keeps defaults
    }
  }, []);

  // Pull live bank balances — called inline once we know Plaid is configured, avoiding a
  // render-cycle waterfall (plaidConfigured state → re-render → second useEffect).
  const loadBalances = useCallback(async () => {
    try {
      const res = await fetch("/api/plaid/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data?.configured && Array.isArray(data.accounts) && data.accounts.length) {
        setBankAccounts(data.accounts);
        setCash(
          data.accounts.reduce(
            (s: number, a: { current: number | null }) => s + (a.current ?? 0),
            0,
          ),
        );
      }
    } catch {
      // keep empty-state
    }
  }, []);

  useEffect(() => {
    Promise.allSettled([
      loadData(),
      fetch("/api/massive/status")
        .then((r) => r.json())
        .then(setApiStatus)
        .catch(() => null),
      fetch("/api/plaid/status")
        .then((r) => r.json())
        .then((s: { configured?: boolean; linked?: boolean } | null) => {
          const configured = !!s?.configured;
          const linked = !!s?.linked;
          setPlaidConfigured(configured);
          setPlaidLinked(linked);
          if (linked) loadBalances();
        })
        .catch(() => null),
      fetch("/api/brokerage/status")
        .then((r) => r.json())
        .then((s: { configured?: boolean } | null) => setBrokerageConfigured(!!s?.configured))
        .catch(() => null),
    ]);
  }, [loadData, loadBalances]);

  async function refreshQuotes() {
    if (!apiStatus?.configured) {
      toast(
        "Polygon API key not configured server-side. Add POLYGON_API_KEY to .env.local or Vercel.",
        "warn",
        "Fund",
      );
      return;
    }

    setRefreshing(true);
    const syms = [...new Set([...holdings.map((h) => h.symbol), ...watchlist.map((w) => w.symbol)])];
    let ok = 0;

    for (const sym of syms) {
      try {
        const res = await fetch(`/api/massive/quote?symbol=${sym}&snapshot=true`);
        if (!res.ok) continue;
        const q = await res.json();
        setHoldings((prev) =>
          prev.map((h) =>
            h.symbol === sym ? { ...h, last_price: q.price } : h,
          ),
        );
        setWatchlist((prev) =>
          prev.map((w) =>
            w.symbol === sym ? { ...w, price: q.price, chg: q.chg } : w,
          ),
        );
        ok++;
      } catch {
        // skip
      }
    }

    setRefreshing(false);
    if (ok > 0) {
      setLive(true);
      toast(`${ok} live quotes via Massive proxy.`, "success", "Fund");
    } else {
      toast("Could not fetch quotes. Simulated data remains.", "error", "Fund");
    }
  }

  const fetchLinkToken = useCallback(async () => {
    try {
      const res = await fetch("/api/plaid/link", { method: "POST" });
      const data = await res.json().catch(() => ({})) as { link_token?: string };
      if (res.ok && data?.link_token) {
        setLinkToken(data.link_token);
      }
    } catch { /* ignore */ }
  }, []);

  const handlePlaidSuccess = useCallback<PlaidLinkOnSuccess>(async (publicToken, metadata) => {
    setPlaidLinking(true);
    try {
      const res = await fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_token: publicToken,
          institution: metadata.institution?.name ?? null,
        }),
      });
      if (res.ok) {
        toast("Bank linked! Loading balances…", "success", "Plaid");
        setPlaidConfigured(true);
        void loadBalances();
        setLinkToken(null);
      } else {
        const err = await res.json().catch(() => ({})) as { error?: string };
        toast(err.error ?? "Failed to link bank.", "error", "Plaid");
      }
    } catch {
      toast("Network error linking bank.", "error", "Plaid");
    } finally {
      setPlaidLinking(false);
    }
  }, [toast, loadBalances]);

  const { open: openPlaidLink, ready: plaidLinkReady } = usePlaidLink({
    token: linkToken,
    onSuccess: handlePlaidSuccess,
    onExit: (err) => {
      if (err) toast("Plaid Link closed.", "warn", "Plaid");
      setLinkToken(null);
    },
  });

  const connectBank = useCallback(async () => {
    if (linkToken && plaidLinkReady) {
      openPlaidLink();
      return;
    }
    await fetchLinkToken();
  }, [linkToken, plaidLinkReady, openPlaidLink, fetchLinkToken]);

  useEffect(() => {
    if (linkToken && plaidLinkReady) {
      openPlaidLink();
    }
  }, [linkToken, plaidLinkReady, openPlaidLink]);

  async function addHolding() {
    if (!addSym.trim()) return;
    const symbol = addSym.trim().toUpperCase();
    if (holdings.some((h) => h.symbol === symbol)) {
      toast(`${symbol} is already in your portfolio.`, "warn", "Fund");
      return;
    }
    const row: HoldingRow = {
      symbol,
      name: addName.trim() || symbol,
      shares: Math.max(parseFloat(addShares) || 0, 0),
      cost_basis: Math.max(parseFloat(addCost) || 0, 0),
    };

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data, error } = await supabase
        .from("fund_holdings")
        .insert({
          user_id: user.id,
          symbol: row.symbol,
          name: row.name,
          shares: row.shares,
          cost_basis: row.cost_basis,
          sort_order: holdings.length,
        })
        .select()
        .single();
      if (error) {
        toast(error.message, "error", "Fund");
        return;
      }
      row.id = data?.id;
      toast(`${row.symbol} added to portfolio.`, "success", "Fund");
    } else {
      toast("Added locally — sign in to sync.", "info", "Fund");
    }
    setHoldings((prev) => [...prev, row]);

    setAddOpen(false);
    setAddSym("");
    setAddName("");
    setAddShares("1");
    setAddCost("0");
  }

  async function removeHolding(row: HoldingRow) {
    setHoldings((prev) => prev.filter((h) => h.symbol !== row.symbol));
    if (row.id) {
      const supabase = createClient();
      await supabase.from("fund_holdings").delete().eq("id", row.id);
    }
    toast(`${row.symbol} removed from portfolio.`, "info", "Fund");
  }

  async function addToWatchlist(sym: string, name: string) {
    if (watchlist.some((w) => w.symbol === sym)) {
      toast(`${sym} is already on the watchlist.`, "warn", "Fund");
      return;
    }
    const row: WatchlistRow = { symbol: sym, name };
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data, error } = await supabase
        .from("fund_watchlist")
        .insert({ user_id: user.id, symbol: sym, name, sort_order: watchlist.length })
        .select()
        .single();
      if (error) {
        toast(error.message, "error", "Fund");
        return;
      }
      row.id = data?.id;
    }
    setWatchlist((prev) => [...prev, row]);
    toast(`${sym} added to watchlist.`, "success", "Fund");
  }

  async function removeFromWatchlist(row: WatchlistRow) {
    setWatchlist((prev) => prev.filter((w) => w.symbol !== row.symbol));
    if (row.id) {
      const supabase = createClient();
      await supabase.from("fund_watchlist").delete().eq("id", row.id);
    }
    toast(`${row.symbol} removed from watchlist.`, "info", "Fund");
  }

  async function runSearch() {
    if (!searchQ.trim()) return;
    if (!apiStatus?.configured) {
      toast("API key required for ticker search.", "warn", "Fund");
      return;
    }
    const res = await fetch(`/api/massive/search?q=${encodeURIComponent(searchQ)}`);
    if (!res.ok) {
      const err = await res.json();
      toast(err.message ?? "Search failed", "error", "Fund");
      return;
    }
    const data = await res.json();
    setSearchHits(data.results ?? []);
  }


  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <button
          type="button"
          className="selectbox"
          style={{ background: "none" }}
          onClick={connectBank}
          title="Connect a brokerage or bank"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 7h18v12H3zM3 11h18" />
          </svg>
          {brokerageConfigured ? "Public ✓" : "Public"} · {plaidConfigured ? "Plaid ✓" : "Plaid"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button type="button" className="feed-manage" onClick={() => setAddOpen(true)}>
          Add holding
        </button>
        <button type="button" className="feed-manage" onClick={refreshQuotes} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh quotes"}
        </button>
        {apiStatus?.configured ? (
          <span className="data-badge live">Live · Massive</span>
        ) : (
          <span className="data-badge simulated">API key missing</span>
        )}
      </div>

      {!apiStatus?.configured ? (
        <Card style={{ marginTop: 16 }}>
          <div className="empty-state">
            <strong>Polygon API not configured</strong>
            <p>
              Add <code>POLYGON_API_KEY</code> to <code>.env.local</code> or Vercel
              environment variables. The server proxy is ready — no browser CORS issues.
            </p>
          </div>
        </Card>
      ) : null}

      <div className="subtabbar" style={{ marginTop: 20 }}>
        {(["overview", "portfolio", "cash", "research"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`subtab${tab === t ? " on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "overview" ? "Overview" : t === "portfolio" ? "Portfolio" : t === "cash" ? "Cash Flow" : "Research"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <div className="fund-hero">
            <Card tick>
              <div className="seclabel">Net Worth</div>
              <div className="bigmetric" style={{ fontSize: 30 }}>{fmtUsd(netWorth)}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--up)", marginTop: 4 }}>
                Cash {fmtUsd(cash)} included
              </div>
              <NetWorthChart cash={cash} invested={invested} netWorth={netWorth} signedIn={signedIn} />
            </Card>
            <Card>
              <div className="seclabel">Invested</div>
              <div className="bigmetric">{fmtUsd(invested)}</div>
              <div className="alloc-bar" style={{ marginTop: 16 }}>
                <i style={{ width: "52%", background: "var(--accent)" }} />
                <i style={{ width: "22%", background: "var(--up)" }} />
                <i style={{ width: "14%", background: "var(--accent-2)" }} />
                <i style={{ width: "12%", background: "var(--clay)" }} />
              </div>
              <div className="alloc-leg">
                <span><b style={{ background: "var(--accent)" }} />Equities 52%</span>
                <span><b style={{ background: "var(--up)" }} />Index 22%</span>
                <span><b style={{ background: "var(--accent-2)" }} />Crypto 14%</span>
                <span><b style={{ background: "var(--clay)" }} />Cash 12%</span>
              </div>
            </Card>
            <Card>
              <div className="seclabel">Cash</div>
              <div className="bigmetric">{fmtUsd(cash)}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
                {bankAccounts.length
                  ? `${bankAccounts.length} account${bankAccounts.length === 1 ? "" : "s"} · Plaid`
                  : plaidLinked
                    ? "Plaid connected"
                    : signedIn
                      ? "No bank linked"
                      : "Demo balances"}
              </div>
              {bankAccounts.length ? (
                bankAccounts.map((a) => (
                  <div key={a.name + (a.mask ?? "")} className="metricrow" style={{ marginTop: 8 }}>
                    <span className="metric-k">
                      {a.name}
                      {a.mask ? ` ··${a.mask}` : ""}
                    </span>
                    <span className="metric-v">{a.current != null ? fmtUsd(a.current) : "—"}</span>
                  </div>
                ))
              ) : signedIn ? (
                <button
                  type="button"
                  className="feed-manage"
                  style={{ marginTop: 14 }}
                  onClick={connectBank}
                >
                  {plaidConfigured ? "Link a bank" : "Connect bank · Plaid"}
                </button>
              ) : (
                <>
                  <div className="metricrow" style={{ marginTop: 14 }}>
                    <span className="metric-k">Checking</span>
                    <span className="metric-v">$8,410</span>
                  </div>
                  <div className="metricrow">
                    <span className="metric-k">HYSA · 4.3%</span>
                    <span className="metric-v">$25,800</span>
                  </div>
                </>
              )}
            </Card>
          </div>
          <div className="divider" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
            <Card tick>
              <h2 className="sec">
                Top Movers
                <span className="rule" />
                <span className="count">Today</span>
              </h2>
              <table className="holdings" style={{ marginTop: 8 }}>
                <tbody>
                  {holdings.slice(0, 4).map((h) => {
                    const gain = holdingGain(h);
                    return (
                      <tr key={h.symbol}>
                        <td>{h.symbol}</td>
                        <td>{h.name}</td>
                        <td>{fmtUsd(holdingValue(h))}</td>
                        <td className={gain >= 0 ? "up" : "down"}>
                          {gain >= 0 ? "▴" : "▾"} {Math.abs(gain).toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
            <Card>
              <h2 className="sec">
                AI Brief
                <span className="rule" />
                <span className="count">Synthesized</span>
              </h2>
              <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.65, marginTop: 10 }}>
                Your book is up 2.2% on the month, led by semis. Concentration in NVDA now 14% of equities — above your 10% rule. Cash is heavy; the HYSA covers ~9 months runway.
              </p>
            </Card>
          </div>
        </>
      )}

      {tab === "portfolio" && (
        <>
          <FundChart symbol={holdings[0]?.symbol ?? "VTI"} live={live && apiStatus?.configured} />
          <div className="divider" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 16,
              alignItems: "start",
            }}
          >
          <Card tick>
            <h2 className="sec">
              Holdings
              <span className="rule" />
              <span className="count">{holdings.length} positions</span>
            </h2>
            {holdings.length === 0 ? (
              <div className="empty-state">
                <strong>No holdings yet</strong>
                <p>Add your first position to start tracking net worth.</p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
              <table className="holdings" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Cost</th>
                    <th>Gain</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => {
                    const gain = holdingGain(h);
                    return (
                      <tr key={h.symbol}>
                        <td>{h.symbol}</td>
                        <td>{h.name}</td>
                        <td>{fmtUsd(holdingValue(h))}</td>
                        <td>{fmtUsd(h.cost_basis)}</td>
                        <td className={gain >= 0 ? "up" : "down"}>
                          {gain >= 0 ? "▴" : "▾"} {Math.abs(gain).toFixed(1)}%
                        </td>
                        <td>
                          <button
                            type="button"
                            title={`Remove ${h.symbol}`}
                            aria-label={`Remove ${h.symbol} from portfolio`}
                            onClick={() => removeHolding(h)}
                            style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer" }}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </Card>
          <FundOrderTicket
            defaultSymbol={holdings[0]?.symbol ?? ""}
            brokerageConfigured={brokerageConfigured}
          />
          </div>
          <div className="divider" />
          <Card>
            <h2 className="sec">
              Watchlist
              <span className="rule" />
            </h2>
            <div className="watch" style={{ marginTop: 12 }}>
              {watchlist.map((w) => (
                <div key={w.symbol} className="wtile" style={{ position: "relative" }}>
                  <button
                    type="button"
                    title={`Remove ${w.symbol}`}
                    aria-label={`Remove ${w.symbol} from watchlist`}
                    onClick={() => removeFromWatchlist(w)}
                    style={{ position: "absolute", top: 4, right: 6, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 11 }}
                  >
                    ×
                  </button>
                  <div className="wsym">
                    {w.symbol}
                    {live && w.price ? <span className="live">live</span> : null}
                  </div>
                  <div className="wprice">{w.price ? fmtUsd2(w.price) : "—"}</div>
                  {w.chg !== undefined ? (
                    <div className={w.chg >= 0 ? "up" : "down"} style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                      {w.chg >= 0 ? "▴" : "▾"} {Math.abs(w.chg).toFixed(1)}%
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {tab === "cash" && (
        signedIn && !bankAccounts.length ? (
          <Card style={{ marginTop: 16 }}>
            <div className="empty-state">
              <strong>Connect a bank to see cash flow</strong>
              <p>
                Income, spend, transactions and budget intelligence populate from your linked
                accounts via Plaid. {plaidConfigured
                  ? "Plaid is configured — link an account to begin."
                  : "Add PLAID_CLIENT_ID and PLAID_SECRET server-side, then link a bank."}
              </p>
              <button
                type="button"
                className="feed-manage"
                style={{ marginTop: 12 }}
                onClick={connectBank}
              >
                {plaidLinked ? "Link another bank" : plaidConfigured ? "Link a bank" : "Connect bank · Plaid"}
              </button>
            </div>
          </Card>
        ) : (
          <>
            <div className="ftop">
              <Card tick>
                <div className="seclabel">Income · mo</div>
                <div className="bigmetric">$6,800</div>
              </Card>
              <Card>
                <div className="seclabel">Spend · mo</div>
                <div className="bigmetric">$4,120</div>
              </Card>
              <Card>
                <div className="seclabel">Saved</div>
                <div className="bigmetric up">39%</div>
              </Card>
            </div>
            <div className="divider" />
            <FundTransactions />
            <div className="divider" />
            <FundBudget />
          </>
        )
      )}

      {tab === "research" && (
        <>
        <Card tick>
          <h2 className="sec">
            Ticker search
            <span className="rule" />
            <span className="count">Massive</span>
          </h2>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="Search tickers — NVDA, Apple…"
              style={{
                flex: 1,
                background: "var(--surface-2)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "8px 11px",
                color: "var(--ink)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                outline: "none",
              }}
            />
            <Button variant="primary" onClick={runSearch}>Search</Button>
          </div>
          <div style={{ marginTop: 10, maxHeight: 180, overflowY: "auto" }}>
            {searchHits.map((hit) => (
              <button
                key={hit.sym}
                type="button"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "8px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: 7,
                  marginBottom: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  background: "transparent",
                  color: "var(--ink)",
                  textAlign: "left",
                }}
                onClick={() => addToWatchlist(hit.sym, hit.name)}
              >
                <span><b>{hit.sym}</b> · {hit.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)" }}>{hit.ex}</span>
              </button>
            ))}
          </div>
        </Card>
        <div className="divider" />
        <FundResearchExtras />
        </>
      )}

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add holding"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={addHolding}>
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <input
            placeholder="Symbol (e.g. AAPL)"
            value={addSym}
            onChange={(e) => setAddSym(e.target.value)}
            className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
          />
          <input
            placeholder="Name (optional)"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-[var(--ink-dim)]">
              Shares
              <input
                type="number"
                min="0"
                step="any"
                value={addShares}
                onChange={(e) => setAddShares(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
              />
            </label>
            <label className="flex-1 text-xs text-[var(--ink-dim)]">
              Total cost basis ($)
              <input
                type="number"
                min="0"
                step="any"
                value={addCost}
                onChange={(e) => setAddCost(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function FundChart({ symbol, live }: { symbol: string; live?: boolean }) {
  const [points, setPoints] = useState<number[]>([]);

  useEffect(() => {
    async function load() {
      if (live) {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const res = await fetch(
          `/api/massive/history?symbol=${symbol}&from=${from}&to=${to}`,
        );
        if (res.ok) {
          const data = await res.json();
          setPoints((data.bars ?? []).map((b: { c: number }) => b.c));
          return;
        }
      }
      // simulated sparkline
      setPoints([100, 102, 101, 105, 103, 108, 110, 109, 112, 115]);
    }
    load();
  }, [symbol, live]);

  if (!points.length) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const norm = points.map((p, i) => {
    const x = (i / (points.length - 1)) * 160;
    const y = 34 - ((p - min) / (max - min || 1)) * 28;
    return `${x},${y}`;
  });

  return (
    <Card className="mt-4">
      <div className="seclabel">
        {symbol} · 90d {live ? "live" : "simulated"}
      </div>
      <svg viewBox="0 0 160 34" className="mt-2 h-10 w-full" preserveAspectRatio="none">
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          points={norm.join(" ")}
        />
      </svg>
    </Card>
  );
}
