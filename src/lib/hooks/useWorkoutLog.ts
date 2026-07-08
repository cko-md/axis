"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { WorkoutLog } from "@/lib/vitality/workout-log";
import { loadWorkoutLog, saveWorkoutLog } from "@/lib/vitality/workout-log-store";

const LS_PREFIX = "axis.workout_log.";

function readLocalLog(sessionId: string): WorkoutLog | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + sessionId);
    return raw ? (JSON.parse(raw) as WorkoutLog) : null;
  } catch {
    return null;
  }
}

function writeLocalLog(log: WorkoutLog) {
  try {
    localStorage.setItem(LS_PREFIX + log.sessionId, JSON.stringify(log));
  } catch {
    /* quota / privacy mode */
  }
}

export type WorkoutLogPersistence = "supabase" | "local" | "signed-out";

export function useWorkoutLog(sessionId: string | null) {
  const supabase = useMemo(() => createClient(), []);
  const [log, setLog] = useState<WorkoutLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<WorkoutLogPersistence>("signed-out");

  const load = useCallback(async () => {
    if (!sessionId) {
      setLog(null);
      setSaveError(null);
      return;
    }
    setLoading(true);
    setSaveError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setPersistence("signed-out");
        setLog(readLocalLog(sessionId));
        return;
      }
      const result = await loadWorkoutLog(supabase, user.id, sessionId);
      if (result.error) {
        setPersistence("local");
        setLog(readLocalLog(sessionId));
        setSaveError("Workout log could not load from Supabase. Showing device-local copy if available.");
        return;
      }
      setPersistence("supabase");
      setLog(result.log ?? readLocalLog(sessionId));
    } finally {
      setLoading(false);
    }
  }, [sessionId, supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: WorkoutLog): Promise<boolean> => {
      setSaveError(null);
      const stamped = { ...next, loggedAt: new Date().toISOString() };
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          writeLocalLog(stamped);
          setLog(stamped);
          setPersistence("signed-out");
          return true;
        }
        const result = await saveWorkoutLog(supabase, user.id, stamped);
        if (result.error) {
          writeLocalLog(stamped);
          setLog(stamped);
          setPersistence("local");
          setSaveError("Workout log saved on this device only — Supabase write failed.");
          return false;
        }
        writeLocalLog(stamped);
        setLog(stamped);
        setPersistence("supabase");
        return true;
      } catch {
        setSaveError("Workout log could not be saved.");
        return false;
      }
    },
    [supabase],
  );

  return { log, setLog, loading, saveError, persistence, save, reload: load };
}
