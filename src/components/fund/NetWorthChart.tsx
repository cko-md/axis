"use client";

import { useEffect, useState } from "react";

type Snapshot = {
  captured_on: string;
  cash: number;
  invested: number;
  liabilities: number;
  net_worth: number;
};

// Pleasant static curve for the signed-out demo view.
const DEMO_POINTS = [0.52, 0.48, 0.5, 0.38, 0.4, 0.28, 0.3, 0.16];

/**
 * Net-worth area chart for the Fund overview. Drops into the existing
 * "Net Worth" card (replaces the old hardcoded sparkline). For signed-in
 * users it captures today's snapshot, then renders the real series from
 * /api/fund/networth. Until two days of history exist it shows the current
 * value with a quiet "building history" caption.
 */
export function NetWorthChart({
  cash,
  invested,
  liabilities = 0,
  netWorth,
  signedIn,
  showLiabilities = false,
}: {
  cash: number;
  invested: number;
  liabilities?: number;
  netWorth: number;
  signedIn: boolean;
  /** Net Worth page passes true to overlay the liabilities series. */
  showLiabilities?: boolean;
}) {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setLoaded(true);
      return;
    }
    let alive = true;
    (async () => {
      // Capture today's point (idempotent per day) only once there's something to record.
      if (netWorth > 0) {
        await fetch("/api/fund/networth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cash, invested, liabilities }),
        }).catch(() => {});
      }
      const res = await fetch("/api/fund/networth").catch(() => null);
      if (res?.ok && alive) {
        const data = await res.json();
        setSnaps(Array.isArray(data.snapshots) ? data.snapshots : []);
      }
      if (alive) setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [signedIn, cash, invested, liabilities, netWorth]);

  // Choose the series to plot.
  const values: number[] = signedIn
    ? snaps.map((s) => Number(s.net_worth))
    : DEMO_POINTS.map((d) => (1 - d) * 100); // demo: invert so it trends up

  const liabilityValues: number[] = signedIn ? snaps.map((s) => Number(s.liabilities)) : [];
  const hasRealSeries = signedIn && values.length >= 2;
  const W = 300;
  const H = 70;

  let polyline = "";
  let polygon = "";
  let liabilityPolyline = "";
  if (hasRealSeries || !signedIn) {
    // Liabilities share the net-worth y-scale so the two lines are visually comparable.
    const allValues = showLiabilities ? [...values, ...liabilityValues] : values;
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const range = max - min || 1;
    const toCoords = (series: number[]) =>
      series.map((v, i) => {
        const x = (i / (Math.max(values.length, 2) - 1)) * W;
        const y = H - 6 - ((v - min) / range) * (H - 16);
        return [x, y] as const;
      });
    const coords = toCoords(values);
    polyline = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    polygon = `${polyline} ${W},${H} 0,${H}`;
    if (showLiabilities && liabilityValues.length >= 2) {
      liabilityPolyline = toCoords(liabilityValues)
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ");
    }
  }

  const caption = !signedIn
    ? "Illustrative trend"
    : !loaded
      ? "Loading history…"
      : hasRealSeries
        ? `${snaps.length}-day trend`
        : "Building history — your trend appears as days accrue";

  return (
    <>
      {polyline ? (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 54, marginTop: 12 }} preserveAspectRatio="none">
          <defs>
            <linearGradient id="nwG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity=".35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={polyline} />
          <polygon fill="url(#nwG)" points={polygon} />
          {liabilityPolyline && (
            <polyline
              fill="none"
              stroke="var(--down)"
              strokeWidth="1.5"
              strokeDasharray="3,2"
              points={liabilityPolyline}
            />
          )}
        </svg>
      ) : (
        <div style={{ height: 54, marginTop: 12 }} />
      )}
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 2, letterSpacing: ".04em" }}>
        {caption}
      </div>
    </>
  );
}
