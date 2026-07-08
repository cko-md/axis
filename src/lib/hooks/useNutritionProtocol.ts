"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";
import { DIETS, type Diet } from "@/lib/recipes";

export type NutritionProtocol = {
  user_id: string;
  diet_protocol: Diet;
  protein_target_g_per_lb: number;
  hydration_target_l: number;
  hydration_current_l: number;
  training_day_carb_bump_g: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const DEFAULTS: Omit<NutritionProtocol, "user_id" | "created_at" | "updated_at"> = {
  diet_protocol: "high-protein",
  protein_target_g_per_lb: 1.0,
  hydration_target_l: 3.0,
  hydration_current_l: 0,
  training_day_carb_bump_g: 40,
  notes: null,
};

const LS_KEY = "axis.nutrition_protocol.v1";

function nowISO() {
  return new Date().toISOString();
}

function buildDefault(userId: string): NutritionProtocol {
  return { ...DEFAULTS, user_id: userId, created_at: nowISO(), updated_at: nowISO() };
}

// localStorage is keyed per user so a signed-in user's protocol survives even before
// the Supabase migration is applied; signed-out visitors share the "demo" bucket.
function lsKey(userId: string) {
  return `${LS_KEY}.${userId}`;
}
function lsRead(userId: string): NutritionProtocol | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lsKey(userId));
    return raw ? (JSON.parse(raw) as NutritionProtocol) : null;
  } catch {
    return null;
  }
}
function lsWrite(userId: string, row: NutritionProtocol) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(userId), JSON.stringify(row));
  } catch {
    // quota / privacy mode — silently ignore
  }
}

function normalize(row: Partial<NutritionProtocol> & { user_id: string }): NutritionProtocol {
  const diet = row.diet_protocol && (DIETS as string[]).includes(row.diet_protocol) ? row.diet_protocol : DEFAULTS.diet_protocol;
  return {
    user_id: row.user_id,
    diet_protocol: diet,
    protein_target_g_per_lb: row.protein_target_g_per_lb ?? DEFAULTS.protein_target_g_per_lb,
    hydration_target_l: row.hydration_target_l ?? DEFAULTS.hydration_target_l,
    hydration_current_l: row.hydration_current_l ?? DEFAULTS.hydration_current_l,
    training_day_carb_bump_g: row.training_day_carb_bump_g ?? DEFAULTS.training_day_carb_bump_g,
    notes: row.notes ?? null,
    created_at: row.created_at ?? nowISO(),
    updated_at: row.updated_at ?? nowISO(),
  };
}

/**
 * Editable, persistent per-user nutrition protocol (diet, macro targets, hydration, notes).
 *
 * Persistence strategy (graceful degradation), mirroring useTrainingWeek:
 *  - Signed-in: try Supabase `nutrition_protocol` singleton row. If the table is
 *    missing (migration not yet applied → Postgres 42P01) we transparently fall
 *    back to localStorage so the feature works immediately.
 *  - Signed-out: localStorage demo bucket, seeded with sane defaults.
 */
export function useNutritionProtocol() {
  const supabase = useMemo(() => createClient(), []);
  const [protocol, setProtocol] = useState<NutritionProtocol | null>(null);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [useLocal, setUseLocal] = useState(false);

  const refresh = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setUserId(null);
      setUseLocal(true);
      const existing = lsRead("demo");
      const row = existing ?? buildDefault("demo");
      if (!existing) lsWrite("demo", row);
      setProtocol(row);
      setLoading(false);
      return;
    }

    setUserId(user.id);

    const { data, error } = await supabase
      .from("nutrition_protocol")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      setUseLocal(false);
      setLoadError("Nutrition protocol could not be loaded. Changes may not sync until you refresh.");
      setProtocol(null);
      setLoading(false);
      return;
    }

    setLoadError(null);
    setUseLocal(false);
    if (!data) {
      const seed = buildDefault(user.id);
      const { data: inserted, error: insErr } = await supabase
        .from("nutrition_protocol")
        .upsert({ ...seed })
        .select()
        .maybeSingle();
      if (insErr || !inserted) {
        setLoadError("Could not save nutrition protocol to Supabase.");
        setProtocol(buildDefault(user.id));
      } else {
        setProtocol(normalize(inserted as NutritionProtocol));
      }
    } else {
      setProtocol(normalize(data as NutritionProtocol));
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "nutrition_protocol", userId, refresh);

  const updateProtocol = useCallback(
    async (patch: Partial<Omit<NutritionProtocol, "user_id" | "created_at">>) => {
      setProtocol((prev) => {
        if (!prev) return prev;
        const next = normalize({ ...prev, ...patch, updated_at: nowISO() });
        if (useLocal || !userId) lsWrite(userId ?? "demo", next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase
        .from("nutrition_protocol")
        .upsert({ user_id: userId, ...patch, updated_at: nowISO() });
    },
    [useLocal, userId, supabase],
  );

  const cycleDiet = useCallback(() => {
    if (!protocol) return;
    const next = DIETS[(DIETS.indexOf(protocol.diet_protocol) + 1) % DIETS.length];
    updateProtocol({ diet_protocol: next });
  }, [protocol, updateProtocol]);

  return {
    protocol,
    loading,
    loadError,
    persistence: useLocal ? ("local" as const) : ("supabase" as const),
    signedIn: !!userId,
    refresh,
    updateProtocol,
    cycleDiet,
  };
}
