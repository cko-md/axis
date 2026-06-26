"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

type Mover = { sym: string; price: number; chg: number };
type NewsItem = { title: string; url: string; publisher: string };

/**
 * Light MVP version of the Market module — movers + news, both already
 * backed by real Massive proxy endpoints. Indices/sectors/earnings calendar
 * are V1 (named, not built — see the implementation plan).
 */
export function FundMarketModule() {
  const [gainers, setGainers] = useState<Mover[]>([]);
  const [losers, setLosers] = useState<Mover[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    fetch("/api/massive/movers?direction=gainers").then((r) => r.json()).then((d) => {
      if (d.error) { setConfigured(false); return; }
      setGainers(d.movers ?? []);
    }).catch(() => setConfigured(false));
    fetch("/api/massive/movers?direction=losers").then((r) => r.json()).then((d) => setLosers(d.movers ?? [])).catch(() => null);
    fetch("/api/massive/news?limit=8").then((r) => r.json()).then((d) => setNews(d.news ?? [])).catch(() => null);
  }, []);

  if (!configured) {
    return (
      <Card>
        <div className="empty-state">
          <strong>Polygon API not configured</strong>
          <p>Add POLYGON_API_KEY to see market movers and news.</p>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card tick>
          <h2 className="sec">Gainers<span className="rule" /></h2>
          {gainers.map((m) => (
            <div key={m.sym} className="metricrow"><span className="metric-k">{m.sym}</span><span className="metric-v up">+{m.chg.toFixed(1)}%</span></div>
          ))}
        </Card>
        <Card>
          <h2 className="sec">Losers<span className="rule" /></h2>
          {losers.map((m) => (
            <div key={m.sym} className="metricrow"><span className="metric-k">{m.sym}</span><span className="metric-v down">{m.chg.toFixed(1)}%</span></div>
          ))}
        </Card>
      </div>
      <div className="divider" />
      <Card>
        <h2 className="sec">Market news<span className="rule" /></h2>
        <div style={{ marginTop: 10 }}>
          {news.map((n) => (
            <a key={n.url} href={n.url} target="_blank" rel="noreferrer" style={{ display: "block", padding: "8px 0", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontSize: 12 }}>
              {n.title}
              <div style={{ fontSize: 9.5, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>{n.publisher}</div>
            </a>
          ))}
        </div>
      </Card>
    </div>
  );
}
