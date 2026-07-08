"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

export type MeditationSession = {
  id: string;
  user_id: string;
  occurred_at: string;
  type: string;
  duration_min: number;
  mood_before: number;
  mood_after: number;
  notes: string;
};

export type MealLog = {
  id: string;
  user_id: string;
  logged_at: string;
  emoji: string;
  title: string;
  timing: string;
  macros: string;
};

// Legacy localStorage key MeditationTab used before this hook existed. Read
// once for the one-time import below; left in place afterward since this
// hook doesn't own its full lifecycle.
const MED_LS_KEY = "axis-meditation-log";

type LegacyMedSession = { id: string; date: string; type: string; durationMin: number; moodBefore: number; moodAfter: number; notes: string };

function readLegacyMedSessions(): LegacyMedSession[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(MED_LS_KEY) ?? "[]"); } catch { return []; }
}

// Meal logs were never persisted before this wave (plain useState, lost on
// every reload) — these are the same example entries that used to be the
// hardcoded INITIAL_MEALS, now seeded once per user so first-time signed-in
// users still see example content, mirroring useNotes.ts's SEED pattern.
const SEED_MEALS = [
  { emoji: "☕", title: "Greek yogurt, berries, granola", timing: "Breakfast · 07:40", macros: "P 32 · 410" },
  { emoji: "🥗", title: "Chicken, quinoa & greens bowl", timing: "Lunch · 12:50", macros: "P 48 · 620" },
  { emoji: "🥤", title: "Whey + banana (post-run)", timing: "Snack · 16:10", macros: "P 30 · 280" },
  { emoji: "🍽️", title: "Salmon, sweet potato, broccoli", timing: "Dinner · planned", macros: "P 32 · 530" },
];

export function useVitalityLogs() {
  const supabase = useMemo(() => createClient(), []);
  const [sessions, setSessions] = useState<MeditationSession[]>([]);
  const [meals, setMeals] = useState<MealLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setSessions([]);
      setMeals([]);
      setLoadError(null);
      setLoading(false);
      return;
    }

    const [sessionsRes, mealsRes] = await Promise.all([
      supabase.from("meditation_sessions").select("*").eq("user_id", user.id),
      supabase.from("meal_logs").select("*").eq("user_id", user.id).order("logged_at", { ascending: false }),
    ]);
    if (sessionsRes.error || mealsRes.error) {
      setLoadError("Vitality logs could not be loaded from Supabase.");
      setSessions([]);
      setMeals([]);
      setLoading(false);
      return;
    }
    setLoadError(null);
    let sessionRows = (sessionsRes.data ?? []) as MeditationSession[];
    let mealRows = (mealsRes.data ?? []) as MealLog[];

    if (sessionRows.length === 0) {
      const legacy = readLegacyMedSessions();
      if (legacy.length > 0) {
        // Coerce numeric/required fields defensively — duration_min/mood_before/
        // mood_after are NOT NULL with no default, and a single malformed row
        // would abort the entire batch insert, dropping every valid session too.
        const { data: inserted } = await supabase
          .from("meditation_sessions")
          .insert(legacy.map((s) => ({
            user_id: user.id,
            occurred_at: s.date || new Date().toISOString(),
            type: s.type || "breath",
            duration_min: Number.isFinite(s.durationMin) ? s.durationMin : 10,
            mood_before: Number.isFinite(s.moodBefore) ? s.moodBefore : 3,
            mood_after: Number.isFinite(s.moodAfter) ? s.moodAfter : 3,
            notes: s.notes ?? "",
          })))
          .select();
        if (inserted?.length) sessionRows = inserted as MeditationSession[];
      }
    }

    if (mealRows.length === 0) {
      const { data: seeded } = await supabase
        .from("meal_logs")
        .insert(SEED_MEALS.map((m) => ({ user_id: user.id, ...m })))
        .select();
      if (seeded?.length) mealRows = seeded as MealLog[];
    }

    setSessions(sessionRows.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()));
    setMeals(mealRows.sort((a, b) => new Date(b.logged_at).getTime() - new Date(a.logged_at).getTime()));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, ["meditation_sessions", "meal_logs"], userId, refresh);

  const addSession = useCallback(async (session: { type: string; durationMin: number; moodBefore: number; moodAfter: number; notes: string }) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from("meditation_sessions")
        .insert({
          user_id: user.id,
          type: session.type,
          duration_min: session.durationMin,
          mood_before: session.moodBefore,
          mood_after: session.moodAfter,
          notes: session.notes,
        })
        .select()
        .single();
      if (error || !data) return null;
      setSessions((prev) => [data as MeditationSession, ...prev]);
      return data as MeditationSession;
    } catch (err) {
      console.error("[useVitalityLogs] addSession", err);
      return null;
    }
  }, [supabase]);

  const addMeal = useCallback(async (meal: { emoji: string; title: string; timing: string; macros: string }) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from("meal_logs")
        .insert({ user_id: user.id, emoji: meal.emoji, title: meal.title, timing: meal.timing, macros: meal.macros })
        .select()
        .single();
      if (error || !data) return null;
      setMeals((prev) => [data as MealLog, ...prev]);
      return data as MealLog;
    } catch (err) {
      console.error("[useVitalityLogs] addMeal", err);
      return null;
    }
  }, [supabase]);

  const removeMeal = useCallback(async (id: string) => {
    try {
      const { error } = await supabase.from("meal_logs").delete().eq("id", id);
      if (error) return { error: error.message };
      setMeals((prev) => prev.filter((m) => m.id !== id));
      return {};
    } catch (err) {
      console.error("[useVitalityLogs] removeMeal", err);
      return { error: "Failed to remove." };
    }
  }, [supabase]);

  return { sessions, meals, loading, loadError, refresh, addSession, addMeal, removeMeal };
}
