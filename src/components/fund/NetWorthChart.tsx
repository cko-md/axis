"use client";

import { useEffect, useState } from "react";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { strictExactMinorUnits } from "@/lib/fund/financialTruth";

type Snapshot = {
  captured_on: string;
  cash: string;
  invested: string;
  liabilities: string;
  net_worth: string;
  /** Timestamp of the last recomputation (added by the provenance migration). */
  computed_at?: string | null;
  /** Conservative oldest provider input used by the calculation. */
  input_as_of?: string | null;
};

// Pleasant static curve for the signed-out demo view.
const DEMO_POINTS = [0.52, 0.48, 0.5, 0.38, 0.4, 0.28, 0.3, 0.16];

/**
 * Net-worth area chart for the Fund overview. Drops into the existing
 * "Net Worth" card (replaces the old hardcoded sparkline). For signed-in
 * users it captures today's snapshot, then renders the real series from
 * /api/fund/networth. Browser-computed values are never persisted; until two
 * days of server-derived history exist it shows a quiet caption.
 */
export function NetWorthChart({
  signedIn,
  showLiabilities = false,
}: {
  signedIn: boolean;
  /** Net Worth page passes true to overlay the liabilities series. */
  showLiabilities?: boolean;
}) {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setLoaded(true);
      return;
    }
    let alive = true;
    (async () => {
      if (alive) setHistoryError(false);
      const res = await fetch("/api/fund/networth").catch(() => null);
      if (res?.ok && alive) {
        const data = await res.json() as { snapshots?: unknown };
        const candidates = Array.isArray(data.snapshots) ? data.snapshots : [];
        const valid = candidates.every((candidate) =>
          Boolean(candidate)
          && typeof candidate === "object"
          && strictExactMinorUnits((candidate as Snapshot).net_worth, "USD") !== null
          && strictExactMinorUnits((candidate as Snapshot).liabilities, "USD") !== null
          && typeof (candidate as Snapshot).captured_on === "string"
          && typeof (candidate as Snapshot).input_as_of === "string",
        );
        setSnaps(valid ? candidates as Snapshot[] : []);
        if (!valid) setHistoryError(true);
      } else if (alive) {
        setHistoryError(true);
      }
      if (alive) setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [signedIn]);

  // Choose the series to plot.
  const values: number[] = signedIn
    ? snaps.map((s) => strictExactMinorUnits(s.net_worth, "USD") as number)
    : DEMO_POINTS.map((d) => (1 - d) * 100); // demo: invert so it trends up

  const liabilityValues: number[] = signedIn
    ? snaps.map((s) => strictExactMinorUnits(s.liabilities, "USD") as number)
    : [];
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

  // Input freshness, not recomputation freshness, is financially meaningful.
  const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const latestSnapshotAt = latest?.input_as_of ?? null;

  const caption = !signedIn
    ? "Illustrative trend"
    : historyError
      ? "Net worth history could not refresh"
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", letterSpacing: ".04em" }}>
          {caption}
        </span>
        {/* Honest freshness signal: only shown once a real snapshot exists,
            driven by the oldest provider input used by the calculation. */}
        {signedIn && loaded && !historyError && latestSnapshotAt && (
          <FreshnessBadge retrievedAt={latestSnapshotAt} sla={FRESHNESS_SLAS.accountBalance} />
        )}
      </div>
    </>
  );
}
