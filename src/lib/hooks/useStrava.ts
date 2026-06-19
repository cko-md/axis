"use client";

import { useEffect, useState, useCallback } from "react";

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
  map?: { summary_polyline?: string };
};

export type StravaStatus = {
  connected: boolean;
  configured: boolean;
  athlete: { name: string; avatar: string } | null;
};

export type StravaRunSummary = {
  weeklyKm: number;
  weeklyKmDelta: number;  // % vs prior week (positive = up)
  avgPace: string;        // "5:12" format
  recentActivities: StravaActivity[];
  stravaContext: string;  // formatted string for AI
};

// ── helpers ──────────────────────────────────────────────────────────────────

function metresToKm(m: number): number {
  return Math.round((m / 1000) * 10) / 10;
}

function speedToPace(mps: number): string {
  if (!mps || mps <= 0) return "—";
  const secPerKm = 1000 / mps;
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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

function computeSummary(activities: StravaActivity[]): StravaRunSummary {
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  const thisWeekRuns = activities.filter(
    (a) => isRun(a) && now - new Date(a.start_date).getTime() < oneWeekMs,
  );
  const lastWeekRuns = activities.filter((a) => {
    const age = now - new Date(a.start_date).getTime();
    return isRun(a) && age >= oneWeekMs && age < 2 * oneWeekMs;
  });

  const weeklyKm = metresToKm(thisWeekRuns.reduce((s, a) => s + a.distance, 0));
  const lastWeekKm = metresToKm(lastWeekRuns.reduce((s, a) => s + a.distance, 0));
  const weeklyKmDelta =
    lastWeekKm > 0 ? Math.round(((weeklyKm - lastWeekKm) / lastWeekKm) * 100) : 0;

  const runActivities = activities.filter(isRun);
  const avgPace =
    runActivities.length
      ? speedToPace(runActivities.reduce((s, a) => s + a.average_speed, 0) / runActivities.length)
      : "—";

  return {
    weeklyKm,
    weeklyKmDelta,
    avgPace,
    recentActivities: activities.slice(0, 8),
    stravaContext: buildStravaContext(activities),
  };
}

// ── hook ─────────────────────────────────────────────────────────────────────

export function useStrava() {
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [summary, setSummary] = useState<StravaRunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activitiesLoading, setActivitiesLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/strava?action=status");
      const data = (await res.json()) as StravaStatus;
      setStatus(data);
      return data.connected;
    } catch {
      setStatus({ connected: false, configured: false, athlete: null });
      return false;
    }
  }, []);

  const fetchActivities = useCallback(async () => {
    setActivitiesLoading(true);
    try {
      const res = await fetch("/api/strava?action=activities");
      const data = await res.json() as { connected: boolean; activities?: StravaActivity[] };
      if (data.connected && data.activities) {
        setActivities(data.activities);
        setSummary(computeSummary(data.activities));
      }
    } catch {
      // fail silently
    } finally {
      setActivitiesLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await fetch("/api/strava?action=disconnect");
    setStatus({ connected: false, configured: status?.configured ?? false, athlete: null });
    setActivities([]);
    setSummary(null);
  }, [status?.configured]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const connected = await fetchStatus();
      if (mounted && connected) await fetchActivities();
      if (mounted) setLoading(false);
    })();
    return () => { mounted = false; };
  }, [fetchStatus, fetchActivities]);

  return {
    status,
    activities,
    summary,
    loading,
    activitiesLoading,
    disconnect,
    refetch: fetchActivities,
  };
}
