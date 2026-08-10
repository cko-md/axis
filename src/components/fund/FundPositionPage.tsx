"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FundSparkline } from "@/components/fund/FundSparkline";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

function formatExactUsd(value: string | null): string {
  if (value === null) return "—";
  const match = value.match(/^(-?)(\d+)\.(\d{2})$/);
  if (!match) return "—";
  return `${match[1]}$${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${match[3]}`;
}

type PositionData = {
  symbol: string;
  shares: string | null;
  costBasis: string | null;
  costBasisMinor: number | null;
  sources: string[];
  quote: { price: string; priceMinor: number; changePercent: number; source: "massive"; asOf: string } | null;
  news: Array<{ title: string; url: string; publisher: string }>;
  liveAvailable: boolean;
  liveReason: string | null;
  positionValue: string | null;
  unrealizedPL: string | null;
  unrealizedPLMinor: number | null;
  weight: number | null;
};

export function FundPositionPage({ symbol }: { symbol: string }) {
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const generationRef = useRef(0);
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [positionData, setPositionData] = useState<PositionData | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [dataIdentity, setDataIdentity] = useState<string | null>(null);

  useEffect(() => {
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setPositionData(null);
    setDataIdentity(null);
    setStatus("loading");
    if (!expectedSubject) {
      setStatus("error");
      return () => controller.abort();
    }
    const isCurrent = () => !controller.signal.aborted
      && generationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    void subjectBoundFetch(expectedSubject, `/api/fund/position/${symbol}`, { signal: controller.signal })
      .then(async (r) => {
        if (!isCurrent()) throw new DOMException("stale subject", "AbortError");
        const body = await r.json() as PositionData;
        if (!isCurrent()) throw new DOMException("stale subject", "AbortError");
        if (!r.ok) throw new Error("POSITION_UNAVAILABLE");
        setPositionData(body);
        setDataIdentity(`${expectedSubject}:${expectedEpoch}`);
        setStatus("ok");
      })
      .catch(() => {
        if (isCurrent()) {
          setDataIdentity(`${expectedSubject}:${expectedEpoch}`);
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [authorityEpoch, currentSubject, symbol]);

  const visibleData = dataIdentity === currentIdentity ? positionData : null;
  const visibleStatus = dataIdentity === currentIdentity ? status : "loading";

  if (visibleStatus === "loading") return <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Loading…</p>;
  if (visibleStatus === "error" || !visibleData) return <p style={{ fontSize: 12, color: "var(--clay)" }}>Could not load this position.</p>;
  const data = visibleData;

  return (
    <div>
      <h1 style={{ fontFamily: "var(--disp)", fontSize: 24, marginBottom: 4 }}>{data.symbol}</h1>
      <FundSparkline symbol={data.symbol} live={!!data.quote} />

      <div className="divider" />
      <div className="fund-hero">
        <Card tick>
          <div className="seclabel">Position value</div>
          <div className="bigmetric">
            {formatExactUsd(data.positionValue)}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
            {data.shares === null ? "—" : data.shares} shares · {data.sources.join(" + ") || "manual"}
          </div>
        </Card>
        <Card>
          <div className="seclabel">Cost basis</div>
          <div className="bigmetric">{formatExactUsd(data.costBasis)}</div>
        </Card>
        <Card>
          <div className="seclabel">Unrealized P/L</div>
          <div className={`bigmetric ${data.unrealizedPLMinor === null ? "" : data.unrealizedPLMinor >= 0 ? "up" : "down"}`}>{formatExactUsd(data.unrealizedPL)}</div>
        </Card>
        <Card>
          <div className="seclabel">Portfolio weight</div>
          <div className="bigmetric">{data.weight === null ? "—" : `${(data.weight * 100).toFixed(1)}%`}</div>
        </Card>
      </div>

      {!data.liveAvailable && (
        <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 12 }}>
          Live position metrics unavailable: {data.liveReason ?? "DATA_UNAVAILABLE"}.
        </p>
      )}

      {data.quote && (
        <>
          <div className="divider" />
          <Card>
            <div className="seclabel">Quote</div>
            <div className="bigmetric">{formatExactUsd(data.quote.price)}</div>
            <div className={data.quote.changePercent >= 0 ? "up" : "down"} style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
              {data.quote.changePercent >= 0 ? "▴" : "▾"} {Math.abs(data.quote.changePercent).toFixed(2)}%
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
