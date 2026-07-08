"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

export type TrainingKind = "run" | "lift" | "mobility" | "rest" | "other";
export type TrainingIntensity = "easy" | "moderate" | "hard" | "key";

export type TrainingSession = {
  id: string;
  user_id: string;
  dow: number; // 0=Mon … 6=Sun
  kind: TrainingKind;
  title: string;
  duration_min: number;
  intensity: TrainingIntensity;
  notes: string | null;
  completed: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const KIND_LABELS: Record<TrainingKind, string> = {
  run: "Run",
  lift: "Lift",
  mobility: "Mobility",
  rest: "Rest",
  other: "Other",
};

export const INTENSITY_LABELS: Record<TrainingIntensity, string> = {
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
  key: "Key",
};

type NewSession = {
  dow: number;
  kind?: TrainingKind;
  title?: string;
  duration_min?: number;
  intensity?: TrainingIntensity;
  notes?: string | null;
};

// Demo seed (signed-out visitors + first-run fallback). Mirrors the old static plan.
const SEED: Array<Omit<NewSession, "dow"> & { dow: number }> = [
  { dow: 0, kind: "run", title: "Easy Run", duration_min: 38, intensity: "easy", notes: "6 km · Z2" },
  { dow: 1, kind: "lift", title: "Strength — Lower", duration_min: 45, intensity: "key", notes: "Posterior chain" },
  { dow: 2, kind: "run", title: "Tempo", duration_min: 48, intensity: "hard", notes: "8 km · Z3-4" },
  { dow: 3, kind: "mobility", title: "Mobility / Yoga", duration_min: 30, intensity: "easy", notes: "Hips + spine" },
  { dow: 4, kind: "rest", title: "Rest", duration_min: 0, intensity: "easy", notes: "Recovery" },
  { dow: 5, kind: "run", title: "Long Run", duration_min: 105, intensity: "key", notes: "18 km · Z2" },
  { dow: 6, kind: "lift", title: "Strength — Upper", duration_min: 40, intensity: "moderate", notes: "Push/pull" },
];

const LS_KEY = "axis.training_week.v1";

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function buildSeed(userId: string): TrainingSession[] {
  return SEED.map((s, i) => ({
    id: uid(),
    user_id: userId,
    dow: s.dow,
    kind: (s.kind ?? "other") as TrainingKind,
    title: s.title ?? "",
    duration_min: s.duration_min ?? 0,
    intensity: (s.intensity ?? "moderate") as TrainingIntensity,
    notes: s.notes ?? null,
    completed: false,
    sort_order: i,
    created_at: nowISO(),
    updated_at: nowISO(),
  }));
}

// localStorage is keyed per user so a signed-in user's plan survives even before
// the Supabase migration is applied; signed-out visitors share the "demo" bucket.
function lsKey(userId: string) {
  return `${LS_KEY}.${userId}`;
}
function lsRead(userId: string): TrainingSession[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lsKey(userId));
    return raw ? (JSON.parse(raw) as TrainingSession[]) : null;
  } catch {
    return null;
  }
}
function lsWrite(userId: string, rows: TrainingSession[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(userId), JSON.stringify(rows));
  } catch {
    // quota / privacy mode — silently ignore
  }
}

/**
 * Editable, persistent 7-day training week.
 *
 * Persistence strategy (graceful degradation):
 *  - Signed-in: try Supabase `training_sessions`. If the table is missing
 *    (migration 005 not yet applied → Postgres 42P01) we transparently fall
 *    back to localStorage so the feature works immediately. Once the migration
 *    is applied, signed-in users persist to the DB under RLS.
 *  - Signed-out: localStorage demo bucket, seeded so the planner is never empty.
 */
export function useTrainingWeek() {
  const supabase = useMemo(() => createClient(), []);
  const [sessions, setSessions] = useState<TrainingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // true once we've decided the DB is unavailable → all writes go to localStorage (signed-out demo only)
  const [useLocal, setUseLocal] = useState(false);

  const persistLocal = useCallback(
    (rows: TrainingSession[], uidOverride?: string) => {
      const id = uidOverride ?? userId ?? "demo";
      lsWrite(id, rows);
    },
    [userId],
  );

  const refresh = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Signed-out → demo bucket
    if (!user) {
      setUserId(null);
      setUseLocal(true);
      setLoadError(null);
      const existing = lsRead("demo");
      const rows = existing ?? buildSeed("demo");
      if (!existing) lsWrite("demo", rows);
      setSessions(rows);
      setLoading(false);
      return;
    }

    setUserId(user.id);

    const { data, error } = await supabase
      .from("training_sessions")
      .select("*")
      .eq("user_id", user.id)
      .order("dow", { ascending: true })
      .order("sort_order", { ascending: true });

    // Signed-in users must not silently fall back to localStorage on DB errors.
    if (error) {
      setUseLocal(false);
      setLoadError("Training plan could not be loaded. Changes may not sync until you refresh.");
      setSessions([]);
      setLoading(false);
      return;
    }

    setLoadError(null);
    setUseLocal(false);
    if (!data?.length) {
      // First run on a real DB — seed once so the planner isn't empty.
      const seed = buildSeed(user.id).map(({ id: _id, created_at: _c, updated_at: _u, ...rest }) => {
        void _id; void _c; void _u;
        return rest;
      });
      const { data: inserted, error: insErr } = await supabase
        .from("training_sessions")
        .insert(seed.map((s) => ({ ...s, user_id: user.id })))
        .select();
      if (insErr || !inserted) {
        setLoadError("Could not seed training plan to Supabase.");
        setSessions([]);
      } else {
        setSessions(inserted as TrainingSession[]);
      }
    } else {
      setSessions(data as TrainingSession[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "training_sessions", userId, refresh);

  const addSession = useCallback(
    async (partial: NewSession) => {
      const dayCount = sessions.filter((s) => s.dow === partial.dow).length;
      const base = {
        dow: partial.dow,
        kind: (partial.kind ?? "run") as TrainingKind,
        title: partial.title ?? "",
        duration_min: partial.duration_min ?? 0,
        intensity: (partial.intensity ?? "moderate") as TrainingIntensity,
        notes: partial.notes ?? null,
        completed: false,
        sort_order: dayCount,
      };

      if (useLocal || !userId) {
        const row: TrainingSession = {
          ...base,
          id: uid(),
          user_id: userId ?? "demo",
          created_at: nowISO(),
          updated_at: nowISO(),
        };
        setSessions((prev) => {
          const next = [...prev, row];
          persistLocal(next);
          return next;
        });
        return row;
      }

      const { data, error } = await supabase
        .from("training_sessions")
        .insert({ ...base, user_id: userId })
        .select()
        .single();
      if (!error && data) {
        setSessions((prev) => [...prev, data as TrainingSession]);
        return data as TrainingSession;
      }
      return null;
    },
    [sessions, useLocal, userId, supabase, persistLocal],
  );

  const updateSession = useCallback(
    async (id: string, patch: Partial<TrainingSession>) => {
      // Optimistic local update for snappy inline editing
      setSessions((prev) => {
        const next = prev.map((s) => (s.id === id ? { ...s, ...patch, updated_at: nowISO() } : s));
        if (useLocal || !userId) persistLocal(next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase
        .from("training_sessions")
        .update({ ...patch, updated_at: nowISO() })
        .eq("id", id);
    },
    [useLocal, userId, supabase, persistLocal],
  );

  const removeSession = useCallback(
    async (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (useLocal || !userId) persistLocal(next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase.from("training_sessions").delete().eq("id", id);
    },
    [useLocal, userId, supabase, persistLocal],
  );

  const toggleComplete = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      return updateSession(id, { completed: !s.completed });
    },
    [sessions, updateSession],
  );

  return {
    sessions,
    loading,
    persistence: useLocal ? ("local" as const) : ("supabase" as const),
    loadError,
    signedIn: !!userId,
    refresh,
    addSession,
    updateSession,
    removeSession,
    toggleComplete,
  };
}
