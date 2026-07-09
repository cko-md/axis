"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";
import type { KeyResultProgressEntry } from "@/lib/objectives/progress";

export type KeyResult = {
  id: string;
  user_id: string;
  objective_id: string;
  title: string;
  current_value: number;
  target_value: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type Objective = {
  id: string;
  user_id: string;
  title: string;
  descriptor: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  key_results: KeyResult[];
};

export type ObjectiveUpdate = Partial<Pick<Objective, "title" | "descriptor" | "sort_order">>;

export type Habit = {
  id: string;
  user_id: string;
  icon: string;
  name: string;
  sort_order: number;
  created_at: string;
  /** ISO dates (yyyy-mm-dd) this habit was checked, newest first */
  checks: string[];
};

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayIso() {
  return isoDay(new Date());
}

/** Last 30 days as heat levels ("" | l1 | l2 | l3) — real checks are binary, so checked days render l3 */
export function habitHeat(habit: Habit): string[] {
  const checked = new Set(habit.checks);
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    return checked.has(isoDay(d)) ? "l3" : "";
  });
}

/** Consecutive checked days ending today or yesterday */
export function habitStreak(habit: Habit): number {
  const checked = new Set(habit.checks);
  const d = new Date();
  if (!checked.has(isoDay(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (checked.has(isoDay(d))) {
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/** Completion percentage over the last 30 days */
export function habitPct(habit: Habit): number {
  const heat = habitHeat(habit);
  return Math.round((heat.filter(Boolean).length / 30) * 100);
}

export function useObjectives() {
  const supabase = useMemo(() => createClient(), []);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setSignedIn(false);
      setObjectives([]);
      setHabits([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setSignedIn(true);
    setLoadError(null);

    const [objsRes, habitsRes] = await Promise.all([
      supabase
        .from("objectives")
        .select("*, key_results (*)")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true }),
      supabase
        .from("habits")
        .select("*, habit_checks (checked_on)")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true }),
    ]);

    if (objsRes.error || habitsRes.error) {
      setLoadError("Objectives could not be loaded.");
      Sentry.captureException(objsRes.error ?? habitsRes.error, {
        tags: { module: "objectives", operation: "refresh" },
      });
    }

    setObjectives(
      (objsRes.data ?? []).map((o) => ({
        ...o,
        key_results: ((o.key_results ?? []) as KeyResult[]).sort((a, b) => a.sort_order - b.sort_order),
      })) as Objective[],
    );
    setHabits(
      (habitsRes.data ?? []).map((h) => ({
        ...h,
        checks: ((h.habit_checks ?? []) as Array<{ checked_on: string }>).map((c) => c.checked_on),
      })) as Habit[],
    );
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, ["objectives", "key_results", "habits", "habit_checks"], userId, refresh);

  const addObjective = useCallback(async (title: string, descriptor: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to save objectives." };
    const { data, error } = await supabase
      .from("objectives")
      .insert({ user_id: user.id, title, descriptor, sort_order: objectives.length })
      .select()
      .single();
    if (error) return { error: error.message };
    const obj = { ...data, key_results: [] } as Objective;
    setObjectives((prev) => [...prev, obj]);
    return { data: obj };
  }, [supabase, objectives.length]);

  const updateObjective = useCallback(async (id: string, patch: ObjectiveUpdate) => {
    const { data, error } = await supabase
      .from("objectives")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setObjectives((prev) =>
      prev.map((o) => (o.id === id ? { ...(data as Omit<Objective, "key_results">), key_results: o.key_results } : o)),
    );
    return { data: data as Omit<Objective, "key_results"> };
  }, [supabase]);

  const deleteObjective = useCallback(async (id: string) => {
    const { error } = await supabase.from("objectives").delete().eq("id", id);
    if (error) return { error: error.message };
    setObjectives((prev) => prev.filter((o) => o.id !== id));
    return {};
  }, [supabase]);

  const addKeyResult = useCallback(async (objectiveId: string, title: string, target: number) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to save key results." };
    const obj = objectives.find((o) => o.id === objectiveId);
    const { data, error } = await supabase
      .from("key_results")
      .insert({
        user_id: user.id,
        objective_id: objectiveId,
        title,
        target_value: target,
        sort_order: obj?.key_results.length ?? 0,
      })
      .select()
      .single();
    if (error) return { error: error.message };
    setObjectives((prev) =>
      prev.map((o) => (o.id === objectiveId ? { ...o, key_results: [...o.key_results, data as KeyResult] } : o)),
    );
    return { data: data as KeyResult };
  }, [supabase, objectives]);

  const updateKeyResult = useCallback(async (id: string, patch: Partial<KeyResult>, source = "manual") => {
    // Capture the pre-update value so a current_value change can be logged to
    // key_result_progress (OBJ-2 history + source explanation).
    const previous = objectives
      .flatMap((o) => o.key_results)
      .find((kr) => kr.id === id)?.current_value;

    const { data, error } = await supabase
      .from("key_results")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    const updated = data as KeyResult;
    setObjectives((prev) =>
      prev.map((o) => ({
        ...o,
        key_results: o.key_results.map((kr) => (kr.id === id ? updated : kr)),
      })),
    );

    // Log the change (append-only, non-blocking). Only when the value actually
    // moved — title/sort edits don't create history noise.
    if (patch.current_value !== undefined && previous !== undefined && updated.current_value !== previous) {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { data: updated, historyError: "Sign in to log progress history." };
      const { error: historyError } = await supabase.from("key_result_progress").insert({
        user_id: user.id,
        key_result_id: id,
        previous_value: previous,
        new_value: updated.current_value,
        delta: updated.current_value - previous,
        source,
      });
      if (historyError) {
        Sentry.captureException(historyError, {
          tags: { area: "objectives", op: "log_key_result_progress", supabase_code: historyError.code ?? "unknown" },
          contexts: { objective: { key_result_id: id } },
        });
        return { data: updated, historyError: "Progress changed, but history could not be logged." };
      }
    }
    return { data: updated };
  }, [supabase, objectives]);

  const fetchKeyResultHistory = useCallback(async (keyResultId: string): Promise<KeyResultProgressEntry[]> => {
    const { data, error } = await supabase
      .from("key_result_progress")
      .select("id, key_result_id, previous_value, new_value, delta, source, created_at")
      .eq("key_result_id", keyResultId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return [];
    return (data ?? []) as KeyResultProgressEntry[];
  }, [supabase]);

  const deleteKeyResult = useCallback(async (id: string) => {
    const { error } = await supabase.from("key_results").delete().eq("id", id);
    if (error) return { error: error.message };
    setObjectives((prev) => prev.map((o) => ({ ...o, key_results: o.key_results.filter((kr) => kr.id !== id) })));
    return {};
  }, [supabase]);

  const addHabit = useCallback(async (icon: string, name: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to save habits." };
    const { data, error } = await supabase
      .from("habits")
      .insert({ user_id: user.id, icon, name, sort_order: habits.length })
      .select()
      .single();
    if (error) return { error: error.message };
    const habit = { ...data, checks: [] } as Habit;
    setHabits((prev) => [...prev, habit]);
    return { data: habit };
  }, [supabase, habits.length]);

  const deleteHabit = useCallback(async (id: string) => {
    const { error } = await supabase.from("habits").delete().eq("id", id);
    if (error) return { error: error.message };
    setHabits((prev) => prev.filter((h) => h.id !== id));
    return {};
  }, [supabase]);

  const toggleHabitToday = useCallback(async (id: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to track habits." };
    const habit = habits.find((h) => h.id === id);
    if (!habit) return {};
    const today = todayIso();
    if (habit.checks.includes(today)) {
      const { error } = await supabase.from("habit_checks").delete().eq("habit_id", id).eq("checked_on", today);
      if (error) return { error: error.message };
      setHabits((prev) => prev.map((h) => (h.id === id ? { ...h, checks: h.checks.filter((c) => c !== today) } : h)));
    } else {
      const { error } = await supabase
        .from("habit_checks")
        .insert({ user_id: user.id, habit_id: id, checked_on: today });
      if (error) return { error: error.message };
      setHabits((prev) => prev.map((h) => (h.id === id ? { ...h, checks: [today, ...h.checks] } : h)));
    }
    return {};
  }, [supabase, habits]);

  return {
    objectives,
    habits,
    loading,
    loadError,
    signedIn,
    refresh,
    addObjective,
    updateObjective,
    deleteObjective,
    addKeyResult,
    updateKeyResult,
    deleteKeyResult,
    fetchKeyResultHistory,
    addHabit,
    deleteHabit,
    toggleHabitToday,
  };
}
