"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DIETS, RECIPES, type Diet, type Recipe } from "@/lib/recipes";

const SAVED_LS_KEY = "axis-supper-saved";
const RECIPES_LS_KEY = "axis-supper-recipes";
const DIET_LS_KEY = "axis-supper-diet";

type PrefsRow = {
  diet: string;
  saved_ids: string[];
  custom_recipes: Recipe[];
};

function readLegacy(): { diet: Diet; savedIds: string[]; customRecipes: Recipe[] } {
  if (typeof window === "undefined") {
    return { diet: "high-protein", savedIds: [], customRecipes: [] };
  }
  let diet: Diet = "high-protein";
  try {
    const stored = localStorage.getItem(DIET_LS_KEY) as Diet | null;
    if (stored && DIETS.includes(stored)) diet = stored;
  } catch { /* ignore */ }
  let savedIds: string[] = [];
  try { savedIds = JSON.parse(localStorage.getItem(SAVED_LS_KEY) ?? "[]") as string[]; } catch { /* ignore */ }
  let customRecipes: Recipe[] = [];
  try { customRecipes = JSON.parse(localStorage.getItem(RECIPES_LS_KEY) ?? "[]") as Recipe[]; } catch { /* ignore */ }
  return { diet, savedIds, customRecipes };
}

export function useSupperClub() {
  const supabase = useMemo(() => createClient(), []);
  const userId = useRef<string | null>(null);
  const [diet, setDietState] = useState<Diet>("high-protein");
  const [savedIds, setSavedIdsState] = useState<string[]>([]);
  const [customRecipes, setCustomRecipesState] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<"supabase" | "local">("local");
  const [signedIn, setSignedIn] = useState(false);

  const persist = useCallback(async (next: PrefsRow) => {
    try {
      localStorage.setItem(DIET_LS_KEY, next.diet);
      localStorage.setItem(SAVED_LS_KEY, JSON.stringify(next.saved_ids));
      localStorage.setItem(RECIPES_LS_KEY, JSON.stringify(next.custom_recipes));
    } catch { /* ignore */ }

    const uid = userId.current;
    if (!uid) return;
    const { error } = await supabase.from("supper_club_prefs" as never).upsert({
      user_id: uid,
      diet: next.diet,
      saved_ids: next.saved_ids,
      custom_recipes: next.custom_recipes,
      updated_at: new Date().toISOString(),
    } as never);
    if (error) {
      setLoadError("Supper Club preferences did not save to Supabase.");
      setPersistence("local");
    } else {
      setLoadError(null);
      setPersistence("supabase");
    }
  }, [supabase]);

  const refresh = useCallback(async () => {
    const legacy = readLegacy();
    setDietState(legacy.diet);
    setSavedIdsState(legacy.savedIds);
    setCustomRecipesState(legacy.customRecipes);

    const { data: { user } } = await supabase.auth.getUser();
    userId.current = user?.id ?? null;
    setSignedIn(!!user);
    if (!user) {
      setPersistence("local");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("supper_club_prefs" as never)
      .select("diet,saved_ids,custom_recipes")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      setLoadError("Supper Club preferences could not be loaded.");
      setPersistence("local");
      setLoading(false);
      return;
    }

    if (data) {
      const row = data as unknown as PrefsRow;
      const d = DIETS.includes(row.diet as Diet) ? (row.diet as Diet) : legacy.diet;
      setDietState(d);
      setSavedIdsState(Array.isArray(row.saved_ids) ? row.saved_ids : []);
      setCustomRecipesState(Array.isArray(row.custom_recipes) ? row.custom_recipes : []);
      setPersistence("supabase");
    } else {
      await persist({
        diet: legacy.diet,
        saved_ids: legacy.savedIds,
        custom_recipes: legacy.customRecipes,
      });
    }
    setLoading(false);
  }, [supabase, persist]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setDiet = useCallback((next: Diet) => {
    setDietState(next);
    void persist({ diet: next, saved_ids: savedIds, custom_recipes: customRecipes });
  }, [persist, savedIds, customRecipes]);

  const toggleSaved = useCallback((id: string) => {
    setSavedIdsState((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      void persist({ diet, saved_ids: next, custom_recipes: customRecipes });
      return next;
    });
  }, [persist, diet, customRecipes]);

  const addCustomRecipe = useCallback((recipe: Recipe) => {
    setCustomRecipesState((prev) => {
      const next = [...prev, recipe];
      void persist({ diet, saved_ids: savedIds, custom_recipes: next });
      return next;
    });
  }, [persist, diet, savedIds]);

  const seedRecipes = useMemo(() => RECIPES, []);

  return {
    diet,
    savedIds,
    customRecipes,
    seedRecipes,
    loading,
    loadError,
    persistence,
    signedIn,
    refresh,
    setDiet,
    toggleSaved,
    addCustomRecipe,
  };
}
