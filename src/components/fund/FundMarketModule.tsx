"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

type Mover = { sym: string; price: number; chg: number };
type NewsItem = { title: string; url: string; publisher: string };

/**
 * Light MVP version of the Market module — movers + news. Movers are
 * scoped to the user's own holdings + watchlist (market-wide gainers/
 * losers returns 403 on the current Polygon plan tier — confirmed live,
 * see /api/massive/movers) — and are arguably more relevant for a
 * personal app anyway. Indices/sectors/earnings calendar are V1 (named,
 * not built — see the implementation plan).
 */
export function FundMarketModule() {
  const [gainers, setGainers] = useState<Mover[]>([]);
  const [losers, setLosers] = useState<Mover[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [moversStatus, setMoversStatus] = useState<"loading" | "ok" | "empty" | "not-configured" | "error">("loading");
  const [moversNotice, setMoversNotice] = useState<string | null>(null);
  const [newsNotice, setNewsNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/massive/movers")
      .then((r) => r.json())
      .then((d: { gainers?: Mover[]; losers?: Mover[]; empty?: boolean; error?: string; partial?: boolean; failed?: number }) => {
        if (d.error) { setMoversStatus(d.error === "POLYGON_API_KEY_NOT_CONFIGURED" ? "not-configured" : "error"); return; }
        if (d.empty) { setMoversStatus("empty"); return; }
        setGainers(d.gainers ?? []);
        setLosers(d.losers ?? []);
        setMoversNotice(d.partial ? `${d.failed ?? "Some"} tracked symbols did not refresh.` : null);
        setMoversStatus("ok");
      })
      .catch(() => setMoversStatus("error"));
    fetch("/api/massive/news?limit=8")
      .then((r) => {
        if (!r.ok) throw new Error("News failed");
        return r.json();
      })
      .then((d) => {
        setNews(d.news ?? []);
        setNewsNotice(null);
      })
      .catch(() => setNewsNotice("Market news could not refresh."));
  }, []);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card tick>
          <h2 className="sec">Gainers<span className="rule" /><span className="count">Your symbols</span></h2>
          {moversStatus === "not-configured" && (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>Add POLYGON_API_KEY to see movers.</p>
          )}
          {moversStatus === "empty" && (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>Add holdings or watchlist symbols to see movers.</p>
          )}
          {moversStatus === "error" && (
            <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 10 }}>Couldn&apos;t load movers.</p>
          )}
          {moversNotice && (
            <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 10 }}>{moversNotice}</p>
          )}
          {moversStatus === "ok" && gainers.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>Nothing up today among your tracked symbols.</p>
          )}
          {gainers.map((m) => (
            <div key={m.sym} className="metricrow"><span className="metric-k">{m.sym}</span><span className="metric-v up">+{m.chg.toFixed(1)}%</span></div>
          ))}
        </Card>
        <Card>
          <h2 className="sec">Losers<span className="rule" /><span className="count">Your symbols</span></h2>
          {moversStatus === "ok" && losers.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>Nothing down today among your tracked symbols.</p>
          )}
          {losers.map((m) => (
            <div key={m.sym} className="metricrow"><span className="metric-k">{m.sym}</span><span className="metric-v down">{m.chg.toFixed(1)}%</span></div>
          ))}
        </Card>
      </div>
      <div className="divider" />
      <Card>
        <h2 className="sec">Market news<span className="rule" /></h2>
        <div style={{ marginTop: 10 }}>
          {newsNotice ? (
            <p style={{ fontSize: 12, color: "var(--clay)" }}>{newsNotice}</p>
          ) : news.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>No recent news, or Polygon is not configured.</p>
          ) : (
            news.map((n) => (
              <a key={n.url} href={n.url} target="_blank" rel="noreferrer" style={{ display: "block", padding: "8px 0", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontSize: 12 }}>
                {n.title}
                <div style={{ fontSize: 9.5, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>{n.publisher}</div>
              </a>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
