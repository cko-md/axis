"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FundSparkline } from "@/components/fund/FundSparkline";
import { fmtUsd, fmtUsd2 } from "@/lib/store/fund-defaults";

type PositionData = {
  symbol: string;
  shares: number;
  costBasis: number;
  sources: string[];
  quote: { price: number; chg: number } | null;
  news: Array<{ title: string; url: string; publisher: string }>;
  unrealizedPL: number;
  weight: number;
};

export function FundPositionPage({ symbol }: { symbol: string }) {
  const [data, setData] = useState<PositionData | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    fetch(`/api/fund/position/${symbol}`)
      .then((r) => r.json())
      .then((d: PositionData) => { setData(d); setStatus("ok"); })
      .catch(() => setStatus("error"));
  }, [symbol]);

  if (status === "loading") return <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>;
  if (status === "error" || !data) return <p style={{ fontSize: 12, color: "var(--clay)" }}>Could not load this position.</p>;

  return (
    <div>
      <h1 style={{ fontFamily: "var(--disp)", fontSize: 24, marginBottom: 4 }}>{data.symbol}</h1>
      <FundSparkline symbol={data.symbol} live={!!data.quote} />

      <div className="divider" />
      <div className="fund-hero">
        <Card tick>
          <div className="seclabel">Position value</div>
          <div className="bigmetric">
            {fmtUsd(data.quote ? data.shares * data.quote.price : data.costBasis)}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
            {data.shares} shares · {data.sources.join(" + ") || "manual"}
          </div>
        </Card>
        <Card>
          <div className="seclabel">Cost basis</div>
          <div className="bigmetric">{fmtUsd(data.costBasis)}</div>
        </Card>
        <Card>
          <div className="seclabel">Unrealized P/L</div>
          <div className={`bigmetric ${data.unrealizedPL >= 0 ? "up" : "down"}`}>{fmtUsd(data.unrealizedPL)}</div>
        </Card>
        <Card>
          <div className="seclabel">Portfolio weight</div>
          <div className="bigmetric">{(data.weight * 100).toFixed(1)}%</div>
        </Card>
      </div>

      {data.quote && (
        <>
          <div className="divider" />
          <Card>
            <div className="seclabel">Quote</div>
            <div className="bigmetric">{fmtUsd2(data.quote.price)}</div>
            <div className={data.quote.chg >= 0 ? "up" : "down"} style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
              {data.quote.chg >= 0 ? "▴" : "▾"} {Math.abs(data.quote.chg).toFixed(2)}%
            </div>
          </Card>
        </>
      )}

      <div className="divider" />
      <Card tick>
        <h2 className="sec">News<span className="rule" /><span className="count">Massive</span></h2>
        <div style={{ marginTop: 10 }}>
          {data.news.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>No recent news, or Polygon is not configured.</p>
          ) : (
            data.news.map((n) => (
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
