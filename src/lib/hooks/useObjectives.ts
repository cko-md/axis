"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
  const [signedIn, setSignedIn] = useState(false);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSignedIn(false);
      setObjectives([]);
      setHabits([]);
      setLoading(false);
      return;
    }
    setSignedIn(true);

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

  const addObjective = async (title: string, descriptor: string) => {
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
  };

  const deleteObjective = async (id: string) => {
    const { error } = await supabase.from("objectives").delete().eq("id", id);
    if (error) return { error: error.message };
    setObjectives((prev) => prev.filter((o) => o.id !== id));
    return {};
  };

  const addKeyResult = async (objectiveId: string, title: string, target: number) => {
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
  };

  const updateKeyResult = async (id: string, patch: Partial<KeyResult>) => {
    const { data, error } = await supabase
      .from("key_results")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setObjectives((prev) =>
      prev.map((o) => ({
        ...o,
        key_results: o.key_results.map((kr) => (kr.id === id ? (data as KeyResult) : kr)),
      })),
    );
    return { data: data as KeyResult };
  };

  const deleteKeyResult = async (id: string) => {
    const { error } = await supabase.from("key_results").delete().eq("id", id);
    if (error) return { error: error.message };
    setObjectives((prev) => prev.map((o) => ({ ...o, key_results: o.key_results.filter((kr) => kr.id !== id) })));
    return {};
  };

  const addHabit = async (icon: string, name: string) => {
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
  };

  const deleteHabit = async (id: string) => {
    const { error } = await supabase.from("habits").delete().eq("id", id);
    if (error) return { error: error.message };
    setHabits((prev) => prev.filter((h) => h.id !== id));
    return {};
  };

  const toggleHabitToday = async (id: string) => {
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
  };

  return {
    objectives,
    habits,
    loading,
    signedIn,
    refresh,
    addObjective,
    deleteObjective,
    addKeyResult,
    updateKeyResult,
    deleteKeyResult,
    addHabit,
    deleteHabit,
    toggleHabitToday,
  };
}
