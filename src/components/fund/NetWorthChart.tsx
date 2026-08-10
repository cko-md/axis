"use client";

import { useEffect, useRef, useState } from "react";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { strictExactMinorUnits } from "@/lib/fund/financialTruth";
import { minorUnitsToDecimalString } from "@/lib/fund/financialTruth";
import { useShellProfile } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

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
  authority?: unknown;
  snapshot_status?: unknown;
  currency?: unknown;
  calculation_version?: unknown;
};

// Pleasant static curve for the signed-out demo view.
const DEMO_POINTS = [0.52, 0.48, 0.5, 0.38, 0.4, 0.28, 0.3, 0.16];

function formatExactUsd(value: string | null): string {
  if (value === null) return "—";
  const match = value.match(/^(-?)(\d+)\.(\d{2})$/);
  if (!match) return "—";
  const whole = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match[1] ? "-" : ""}$${whole}.${match[3]}`;
}

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
  showHeadline = false,
}: {
  signedIn: boolean;
  /** Net Worth page passes true to overlay the liabilities series. */
  showLiabilities?: boolean;
  showHeadline?: boolean;
}) {
  const { state: accountState, profile, authorityEpoch = 0 } = useShellProfile();
  const currentSubject = accountState === "ready" ? profile?.subject ?? null : null;
  const currentSubjectRef = useRef(currentSubject);
  const authorityEpochRef = useRef(authorityEpoch);
  const requestGenerationRef = useRef(0);
  const currentIdentity = currentSubject ? `${currentSubject}:${authorityEpoch}` : null;
  currentSubjectRef.current = currentSubject;
  authorityEpochRef.current = authorityEpoch;
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [snapshotIdentity, setSnapshotIdentity] = useState<string | null>(null);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    const expectedSubject = currentSubject;
    const expectedEpoch = authorityEpoch;
    const controller = new AbortController();
    setSnaps([]);
    setHistoryError(false);
    setLoaded(false);
    if (!signedIn || !expectedSubject) {
      setSnapshotIdentity(null);
      setLoaded(true);
      return () => controller.abort();
    }
    const isCurrent = () =>
      !controller.signal.aborted
      && requestGenerationRef.current === generation
      && currentSubjectRef.current === expectedSubject
      && authorityEpochRef.current === expectedEpoch;
    (async () => {
      const res = await subjectBoundFetch(expectedSubject, "/api/fund/networth", {
        signal: controller.signal,
      }).catch(() => null);
      if (!isCurrent()) return;
      if (res?.ok) {
        const data = await res.json() as { snapshots?: unknown };
        if (!isCurrent()) return;
        const candidates = Array.isArray(data.snapshots) ? data.snapshots : [];
        const valid = candidates.every((candidate) =>
          Boolean(candidate)
          && typeof candidate === "object"
          && strictExactMinorUnits((candidate as Snapshot).net_worth, "USD") !== null
          && strictExactMinorUnits((candidate as Snapshot).liabilities, "USD") !== null
          && typeof (candidate as Snapshot).captured_on === "string"
          && typeof (candidate as Snapshot).input_as_of === "string"
          && (candidate as Snapshot).authority === "provider"
          && (candidate as Snapshot).snapshot_status === "fresh"
          && (candidate as Snapshot).currency === "USD"
          && (candidate as Snapshot).calculation_version === "financial-truth-v2"
        );
        setSnaps(valid ? candidates as Snapshot[] : []);
        if (!valid) setHistoryError(true);
      } else {
        setHistoryError(true);
      }
      if (isCurrent()) {
        setSnapshotIdentity(`${expectedSubject}:${expectedEpoch}`);
        setLoaded(true);
      }
    })().catch(() => {
      if (isCurrent()) {
        setHistoryError(true);
        setSnapshotIdentity(`${expectedSubject}:${expectedEpoch}`);
        setLoaded(true);
      }
    });
    return () => controller.abort();
  }, [authorityEpoch, currentSubject, signedIn]);

  // Choose the series to plot.
  const visibleSnaps = snapshotIdentity === currentIdentity ? snaps : [];
  const visibleLoaded = !signedIn ? loaded : snapshotIdentity === currentIdentity && loaded;
  const visibleHistoryError = snapshotIdentity === currentIdentity && historyError;
  const values: number[] = signedIn
    ? visibleSnaps.map((s) => strictExactMinorUnits(s.net_worth, "USD") as number)
    : DEMO_POINTS.map((d) => (1 - d) * 100); // demo: invert so it trends up

  const liabilityValues: number[] = signedIn
    ? visibleSnaps.map((s) => strictExactMinorUnits(s.liabilities, "USD") as number)
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
  const latest = visibleSnaps.length > 0 ? visibleSnaps[visibleSnaps.length - 1] : null;
  const latestSnapshotAt = latest?.input_as_of ?? null;
  const latestMinor = latest ? strictExactMinorUnits(latest.net_worth, "USD") : null;
  const latestExact = latestMinor === null ? null : minorUnitsToDecimalString(latestMinor, "USD");
  const latestDisplay = formatExactUsd(latestExact);

  const caption = !signedIn
    ? "Illustrative trend"
    : visibleHistoryError
      ? "Net worth history could not refresh"
    : !visibleLoaded
      ? "Loading history…"
      : hasRealSeries
        ? `${visibleSnaps.length}-day trend`
        : "Building history — your trend appears as days accrue";

  return (
    <>
      {showHeadline && (
        <>
          <div className="bigmetric" style={{ fontSize: 30 }}>{latestDisplay}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: visibleHistoryError ? "var(--clay)" : "var(--ink-dim)", marginTop: 4 }}>
            {!visibleLoaded ? "Loading provider-verified net worth…" : visibleHistoryError ? "Net worth unavailable" : latest ? "Provider-verified snapshot" : "No provider-verified snapshot yet"}
          </div>
        </>
      )}
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
        {signedIn && visibleLoaded && !visibleHistoryError && latestSnapshotAt && (
          <FreshnessBadge retrievedAt={latestSnapshotAt} sla={FRESHNESS_SLAS.accountBalance} />
        )}
      </div>
    </>
  );
}
