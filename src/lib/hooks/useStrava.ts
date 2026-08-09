"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { AccountState } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

export type StravaActivity = {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  distance: number;         // metres
  moving_time: number;      // seconds
  elapsed_time: number;     // seconds
  total_elevation_gain: number;
  average_speed: number;    // m/s
  max_speed: number;        // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  kudos_count?: number;
  achievement_count?: number;
  pr_count?: number;
  map?: { summary_polyline?: string };
};

export type StravaStatus = {
  connected: boolean;
  configured: boolean;
  athlete: { name: string; avatar: string } | null;
};

export type StravaRunSummary = {
  weeklyKm: number;
  weeklyDist: number;     // weekly distance in `distUnit` (km or mi, per requested unit)
  distUnit: PaceUnit;
  weeklyKmDelta: number;  // % vs prior week (positive = up)
  avgPace: string;        // "5:12" format, per `distUnit`
  recentActivities: StravaActivity[];
  stravaContext: string;  // formatted string for AI
};

export type StravaHighlights = {
  totalKudos: number;          // sum of kudos_count across recent activities
  prActivityCount: number;     // count of activities with pr_count > 0 or achievement_count > 0
  prActivities: StravaActivity[]; // most recent PR/achievement activities, newest first
};

// ── helpers ──────────────────────────────────────────────────────────────────

export type PaceUnit = "km" | "mi";
const METRES_PER_MILE = 1609.34;

function metresToKm(m: number): number {
  return Math.round((m / 1000) * 10) / 10;
}

export function metresToMiles(m: number): number {
  return Math.round((m / METRES_PER_MILE) * 10) / 10;
}

/** Convert m/s to a pace string like "5:12", per-km or per-mile depending on `unit`. */
export function speedToPace(mps: number, unit: PaceUnit = "km"): string {
  if (!mps || mps <= 0) return "—";
  const distPerUnit = unit === "mi" ? METRES_PER_MILE : 1000;
  const secPerUnit = distPerUnit / mps;
  const mins = Math.floor(secPerUnit / 60);
  const secs = Math.round(secPerUnit % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Convert metres to the given unit (km or mi), rounded to 1dp. */
export function metresToUnit(m: number, unit: PaceUnit = "km"): number {
  return unit === "mi" ? metresToMiles(m) : metresToKm(m);
}

function isRun(a: StravaActivity) {
  return a.sport_type === "Run" || a.type === "Run";
}

function buildStravaContext(activities: StravaActivity[]): string {
  const now = Date.now();
  const fourWeeksMs = 28 * 24 * 60 * 60 * 1000;
  const recent = activities.filter(
    (a) => isRun(a) && now - new Date(a.start_date).getTime() < fourWeeksMs,
  );
  if (!recent.length) return "";

  const weeks: Record<number, { distance: number; count: number; longRun: number }> = {};
  for (const a of recent) {
    const daysAgo = Math.floor((now - new Date(a.start_date).getTime()) / (86400 * 1000));
    const weekIdx = Math.floor(daysAgo / 7);
    if (!weeks[weekIdx]) weeks[weekIdx] = { distance: 0, count: 0, longRun: 0 };
    weeks[weekIdx].distance += a.distance;
    weeks[weekIdx].count += 1;
    if (a.distance > weeks[weekIdx].longRun) weeks[weekIdx].longRun = a.distance;
  }

  const avgPace = speedToPace(recent.reduce((s, a) => s + a.average_speed, 0) / recent.length);

  const lines = ["Recent Strava running data (last 4 weeks):"];
  for (let w = 3; w >= 0; w--) {
    const wk = weeks[w];
    if (wk) {
      const label = w === 0 ? "This week" : w === 1 ? "Last week" : `${w * 7}d ago week`;
      lines.push(`  ${label}: ${metresToKm(wk.distance)} km across ${wk.count} run(s), longest ${metresToKm(wk.longRun)} km`);
    }
  }
  lines.push(`  Average easy pace: ${avgPace} /km`);
  lines.push(`  Total runs in period: ${recent.length}`);
  return lines.join("\n");
}

function computeSummary(activities: StravaActivity[], unit: PaceUnit = "km"): StravaRunSummary {
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  const thisWeekRuns = activities.filter(
    (a) => isRun(a) && now - new Date(a.start_date).getTime() < oneWeekMs,
  );
  const lastWeekRuns = activities.filter((a) => {
    const age = now - new Date(a.start_date).getTime();
    return isRun(a) && age >= oneWeekMs && age < 2 * oneWeekMs;
  });

  const thisWeekDistM = thisWeekRuns.reduce((s, a) => s + a.distance, 0);
  const weeklyKm = metresToKm(thisWeekDistM);
  const weeklyDist = unit === "mi" ? metresToMiles(thisWeekDistM) : weeklyKm;
  const lastWeekKm = metresToKm(lastWeekRuns.reduce((s, a) => s + a.distance, 0));
  const weeklyKmDelta =
    lastWeekKm > 0 ? Math.round(((weeklyKm - lastWeekKm) / lastWeekKm) * 100) : 0;

  const runActivities = activities.filter(isRun);
  const avgPace =
    runActivities.length
      ? speedToPace(runActivities.reduce((s, a) => s + a.average_speed, 0) / runActivities.length, unit)
      : "—";

  return {
    weeklyKm,
    weeklyDist,
    distUnit: unit,
    weeklyKmDelta,
    avgPace,
    recentActivities: activities.slice(0, 8),
    stravaContext: buildStravaContext(activities),
  };
}

function computeHighlights(activities: StravaActivity[]): StravaHighlights {
  const totalKudos = activities.reduce((s, a) => s + (a.kudos_count ?? 0), 0);
  const prActivities = activities
    .filter((a) => (a.pr_count ?? 0) > 0 || (a.achievement_count ?? 0) > 0)
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())
    .slice(0, 5);
  return {
    totalKudos,
    prActivityCount: prActivities.length,
    prActivities,
  };
}

// ── hook ─────────────────────────────────────────────────────────────────────

type StravaAuthority = {
  subject: string;
  epoch: number;
};

export function useStrava(
  initialUnit: PaceUnit = "km",
  providerAuthority?: {
    subject: string | null;
    accountState: AccountState;
    authorityEpoch: number;
  },
) {
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [summary, setSummary] = useState<StravaRunSummary | null>(null);
  const [highlights, setHighlights] = useState<StravaHighlights | null>(null);
  const [loading, setLoading] = useState(true);
  const [activitiesLoading, setActivitiesLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [activitiesError, setActivitiesError] = useState<string | null>(null);
  const [unit, setUnit] = useState<PaceUnit>(initialUnit);
  // Kept in sync with `unit` via effect below; lets fetchActivities read the
  // latest unit without depending on it (so toggling the unit never triggers
  // a redundant network re-fetch — only a local recompute).
  const unitRef = useRef(unit);
  const controllersRef = useRef(new Set<AbortController>());
  const authorityRef = useRef<StravaAuthority | null>(null);
  const dataAuthorityRef = useRef<StravaAuthority | null>(null);
  authorityRef.current = providerAuthority?.accountState === "ready" && providerAuthority.subject
    ? { subject: providerAuthority.subject, epoch: providerAuthority.authorityEpoch }
    : null;
  useEffect(() => {
    unitRef.current = unit;
  }, [unit]);

  const isCurrent = useCallback((authority: StravaAuthority) => {
    const current = authorityRef.current;
    return current?.subject === authority.subject && current.epoch === authority.epoch;
  }, []);

  const beginRequest = useCallback(() => {
    const authority = authorityRef.current;
    if (!authority) return null;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return { authority, controller };
  }, []);

  const clearProviderState = useCallback(() => {
    dataAuthorityRef.current = null;
    setStatus(null);
    setActivities([]);
    setSummary(null);
    setHighlights(null);
    setStatusError(null);
    setActivitiesError(null);
    setActivitiesLoading(false);
  }, []);

  const fetchStatus = useCallback(async () => {
    const operation = beginRequest();
    if (!operation) return false;
    const { authority, controller } = operation;
    try {
      const res = await subjectBoundFetch(authority.subject, "/api/strava?action=status", {
        signal: controller.signal,
      });
      if (!isCurrent(authority) || controller.signal.aborted) return false;
      const data = await res.json().catch(() => null) as StravaStatus | null;
      if (!isCurrent(authority) || controller.signal.aborted) return false;
      if (!res.ok) {
        dataAuthorityRef.current = authority;
        setStatusError("Strava status could not be loaded.");
        setStatus({ connected: false, configured: false, athlete: null });
        return false;
      }
      if (!data) {
        dataAuthorityRef.current = authority;
        setStatusError("Strava status could not be loaded.");
        return false;
      }
      dataAuthorityRef.current = authority;
      setStatus(data);
      setStatusError(null);
      return data.connected;
    } catch {
      if (!isCurrent(authority) || controller.signal.aborted) return false;
      dataAuthorityRef.current = authority;
      setStatusError("Strava status could not be loaded.");
      setStatus({ connected: false, configured: false, athlete: null });
      return false;
    } finally {
      controllersRef.current.delete(controller);
    }
  }, [beginRequest, isCurrent]);

  const fetchActivities = useCallback(async () => {
    const operation = beginRequest();
    if (!operation) return;
    const { authority, controller } = operation;
    setActivitiesLoading(true);
    setActivitiesError(null);
    try {
      const res = await subjectBoundFetch(authority.subject, "/api/strava?action=activities", {
        signal: controller.signal,
      });
      if (!isCurrent(authority) || controller.signal.aborted) return;
      const data = await res.json().catch(() => null) as {
        connected: boolean;
        activities?: StravaActivity[];
      } | null;
      if (!isCurrent(authority) || controller.signal.aborted) return;
      if (!res.ok) {
        dataAuthorityRef.current = authority;
        setActivitiesError("Strava activities could not be loaded.");
        return;
      }
      if (data?.connected && data.activities) {
        dataAuthorityRef.current = authority;
        setActivities(data.activities);
        setSummary(computeSummary(data.activities, unitRef.current));
        setHighlights(computeHighlights(data.activities));
      }
    } catch {
      if (!isCurrent(authority) || controller.signal.aborted) return;
      dataAuthorityRef.current = authority;
      setActivitiesError("Strava activities could not be loaded.");
    } finally {
      controllersRef.current.delete(controller);
      if (isCurrent(authority) && !controller.signal.aborted) setActivitiesLoading(false);
    }
  }, [beginRequest, isCurrent]);

  // Recompute the summary (pace/distance strings) when the unit changes,
  // without re-fetching from the network.
  useEffect(() => {
    setSummary((prev) => (prev ? computeSummary(activities, unit) : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);

  const disconnect = useCallback(async () => {
    const operation = beginRequest();
    if (!operation) return;
    const { authority, controller } = operation;
    try {
      const response = await subjectBoundFetch(
        authority.subject,
        "/api/strava?action=disconnect",
        { method: "POST", signal: controller.signal },
      );
      if (!isCurrent(authority) || controller.signal.aborted) return;
      if (!response.ok) {
        dataAuthorityRef.current = authority;
        setStatusError("Strava could not be disconnected.");
        return;
      }
      dataAuthorityRef.current = authority;
      setStatus({ connected: false, configured: status?.configured ?? false, athlete: null });
      setActivities([]);
      setSummary(null);
      setHighlights(null);
    } finally {
      controllersRef.current.delete(controller);
    }
  }, [beginRequest, isCurrent, status?.configured]);

  const refetchStatus = useCallback(async () => {
    const connected = await fetchStatus();
    if (connected) await fetchActivities();
    return connected;
  }, [fetchStatus, fetchActivities]);

  useEffect(() => {
    const controllers = controllersRef.current;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    clearProviderState();
    if (!authorityRef.current) {
      setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const connected = await fetchStatus();
        if (active && connected) await fetchActivities();
      } finally {
        if (active && authorityRef.current) setLoading(false);
      }
    })();
    return () => {
      active = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [
    clearProviderState,
    fetchActivities,
    fetchStatus,
    providerAuthority?.accountState,
    providerAuthority?.authorityEpoch,
    providerAuthority?.subject,
  ]);

  const currentAuthority = authorityRef.current;
  const dataAuthority = dataAuthorityRef.current;
  const mayRenderProviderState = Boolean(
    currentAuthority &&
    dataAuthority &&
    currentAuthority.subject === dataAuthority.subject &&
    currentAuthority.epoch === dataAuthority.epoch,
  );

  return {
    status: mayRenderProviderState ? status : null,
    activities: mayRenderProviderState ? activities : [],
    summary: mayRenderProviderState ? summary : null,
    highlights: mayRenderProviderState ? highlights : null,
    loading,
    activitiesLoading,
    statusError: mayRenderProviderState ? statusError : null,
    activitiesError: mayRenderProviderState ? activitiesError : null,
    unit,
    setUnit,
    disconnect,
    refetch: fetchActivities,
    refetchStatus,
  };
}
