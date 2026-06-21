"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type FitnessDiscipline = "strength" | "mobility";

export type FitnessExercise = {
  id: string;
  routine_id: string;
  user_id: string;
  name: string;
  sets: number | null;
  reps: string | null;
  weight: string | null;
  rest: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type FitnessRoutine = {
  id: string;
  user_id: string;
  discipline: FitnessDiscipline;
  name: string;
  category: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  exercises: FitnessExercise[];
};

type NewExercise = {
  name?: string;
  sets?: number | null;
  reps?: string | null;
  weight?: string | null;
  rest?: string | null;
};

// Demo seed mirrors the previous hardcoded JSX so the tabs are never empty.
const STRENGTH_SEED: Array<{ category: string; exercises: NewExercise[] }> = [
  {
    category: "Upper · Push",
    exercises: [
      { name: "Incline DB Press", sets: 4, reps: "8" },
      { name: "Weighted Dips", sets: 3, reps: "10" },
      { name: "Lateral Raise", sets: 3, reps: "15" },
    ],
  },
  {
    category: "Lower · Posterior",
    exercises: [
      { name: "Romanian Deadlift", sets: 4, reps: "6" },
      { name: "Bulgarian Split Squat", sets: 3, reps: "10" },
      { name: "Calf Raise", sets: 4, reps: "15" },
    ],
  },
  {
    category: "Conditioning · EMOM 20",
    exercises: [
      { name: "Kettlebell swings", sets: null, reps: "15" },
      { name: "Burpees", sets: null, reps: "12" },
      { name: "Row", sets: null, reps: "250m" },
      { name: "Rest", sets: null, reps: "—" },
    ],
  },
];

const MOBILITY_SEED: Array<{ category: string; exercises: NewExercise[] }> = [
  {
    category: "Runner's Mobility · 15 min",
    exercises: [
      { name: "Hip flexor flow", sets: null, reps: "3 min" },
      { name: "Pigeon → thread the needle", sets: null, reps: "4 min" },
      { name: "Pilates hundred + dead bug", sets: null, reps: "5 min" },
      { name: "Box breathing", sets: null, reps: "3 min" },
    ],
  },
];

const SEED_BY_DISCIPLINE: Record<FitnessDiscipline, Array<{ category: string; exercises: NewExercise[] }>> = {
  strength: STRENGTH_SEED,
  mobility: MOBILITY_SEED,
};

const LS_KEY = "axis.fitness_routines.v1";

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function buildSeed(userId: string, discipline: FitnessDiscipline): FitnessRoutine[] {
  return SEED_BY_DISCIPLINE[discipline].map((r, ri) => {
    const routineId = uid();
    return {
      id: routineId,
      user_id: userId,
      discipline,
      name: r.category,
      category: r.category,
      sort_order: ri,
      created_at: nowISO(),
      updated_at: nowISO(),
      exercises: r.exercises.map((ex, ei) => ({
        id: uid(),
        routine_id: routineId,
        user_id: userId,
        name: ex.name ?? "",
        sets: ex.sets ?? null,
        reps: ex.reps ?? null,
        weight: ex.weight ?? null,
        rest: ex.rest ?? null,
        sort_order: ei,
        created_at: nowISO(),
        updated_at: nowISO(),
      })),
    };
  });
}

function lsKey(userId: string, discipline: FitnessDiscipline) {
  return `${LS_KEY}.${discipline}.${userId}`;
}
function lsRead(userId: string, discipline: FitnessDiscipline): FitnessRoutine[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lsKey(userId, discipline));
    return raw ? (JSON.parse(raw) as FitnessRoutine[]) : null;
  } catch {
    return null;
  }
}
function lsWrite(userId: string, discipline: FitnessDiscipline, rows: FitnessRoutine[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(userId, discipline), JSON.stringify(rows));
  } catch {
    // quota / privacy mode — silently ignore
  }
}

/**
 * Editable, persistent fitness routines (Strength & Conditioning / Yoga & Pilates tabs).
 *
 * Persistence strategy (graceful degradation), mirroring useTrainingWeek / useNutritionProtocol:
 *  - Signed-in: try Supabase `fitness_routines` + `fitness_routine_exercises`. If the
 *    tables are missing (migration not yet applied → Postgres 42P01) we transparently
 *    fall back to localStorage so the feature works immediately.
 *  - Signed-out: localStorage demo bucket, seeded so the tab is never empty.
 */
export function useFitnessRoutines(discipline: FitnessDiscipline) {
  const supabase = useMemo(() => createClient(), []);
  const [routines, setRoutines] = useState<FitnessRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [useLocal, setUseLocal] = useState(false);

  const persistLocal = useCallback(
    (rows: FitnessRoutine[], uidOverride?: string) => {
      const id = uidOverride ?? userId ?? "demo";
      lsWrite(id, discipline, rows);
    },
    [userId, discipline],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setUserId(null);
      setUseLocal(true);
      const existing = lsRead("demo", discipline);
      const rows = existing ?? buildSeed("demo", discipline);
      if (!existing) lsWrite("demo", discipline, rows);
      setRoutines(rows);
      setLoading(false);
      return;
    }

    setUserId(user.id);

    const { data, error } = await supabase
      .from("fitness_routines")
      .select("*, fitness_routine_exercises(*)")
      .eq("user_id", user.id)
      .eq("discipline", discipline)
      .order("sort_order", { ascending: true });

    if (error) {
      setUseLocal(true);
      const existing = lsRead(user.id, discipline);
      const rows = existing ?? buildSeed(user.id, discipline);
      if (!existing) lsWrite(user.id, discipline, rows);
      setRoutines(rows);
      setLoading(false);
      return;
    }

    setUseLocal(false);
    const mapRow = (row: Record<string, unknown>): FitnessRoutine => {
      const exRows = (row.fitness_routine_exercises as FitnessExercise[] | null) ?? [];
      return {
        id: row.id as string,
        user_id: row.user_id as string,
        discipline: row.discipline as FitnessDiscipline,
        name: row.name as string,
        category: row.category as string,
        sort_order: row.sort_order as number,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        exercises: [...exRows].sort((a, b) => a.sort_order - b.sort_order),
      };
    };

    if (!data?.length) {
      // First run on a real DB — seed once so the tab isn't empty.
      const seed = buildSeed(user.id, discipline);
      const routineInserts = seed.map((r) => ({
        user_id: user.id,
        discipline,
        name: r.name,
        category: r.category,
        sort_order: r.sort_order,
      }));
      const { data: insertedRoutines, error: insErr } = await supabase
        .from("fitness_routines")
        .insert(routineInserts)
        .select();

      if (insErr || !insertedRoutines) {
        setUseLocal(true);
        const rows = buildSeed(user.id, discipline);
        lsWrite(user.id, discipline, rows);
        setRoutines(rows);
        setLoading(false);
        return;
      }

      const exerciseInserts = (insertedRoutines as Array<{ id: string; sort_order: number }>).flatMap((row) => {
        const seedRoutine = seed[row.sort_order];
        if (!seedRoutine) return [];
        return seedRoutine.exercises.map((ex) => ({
          routine_id: row.id,
          user_id: user.id,
          name: ex.name,
          sets: ex.sets,
          reps: ex.reps,
          weight: ex.weight,
          rest: ex.rest,
          sort_order: ex.sort_order,
        }));
      });

      let insertedExercises: FitnessExercise[] = [];
      if (exerciseInserts.length) {
        const { data: exData } = await supabase
          .from("fitness_routine_exercises")
          .insert(exerciseInserts)
          .select();
        insertedExercises = (exData as FitnessExercise[] | null) ?? [];
      }

      const finalRows = (insertedRoutines as Array<Record<string, unknown>>).map((row) =>
        mapRow({ ...row, fitness_routine_exercises: insertedExercises.filter((e) => e.routine_id === row.id) }),
      );
      setRoutines(finalRows);
    } else {
      setRoutines((data as Array<Record<string, unknown>>).map(mapRow));
    }
    setLoading(false);
  }, [supabase, discipline]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addRoutine = useCallback(
    async (name: string, exercises: NewExercise[] = []) => {
      const sortOrder = routines.length;
      const routineId = uid();
      const now = nowISO();
      const exRows: FitnessExercise[] = exercises.map((ex, i) => ({
        id: uid(),
        routine_id: routineId,
        user_id: userId ?? "demo",
        name: ex.name ?? "",
        sets: ex.sets ?? null,
        reps: ex.reps ?? null,
        weight: ex.weight ?? null,
        rest: ex.rest ?? null,
        sort_order: i,
        created_at: now,
        updated_at: now,
      }));

      if (useLocal || !userId) {
        const row: FitnessRoutine = {
          id: routineId,
          user_id: userId ?? "demo",
          discipline,
          name,
          category: name,
          sort_order: sortOrder,
          created_at: now,
          updated_at: now,
          exercises: exRows,
        };
        setRoutines((prev) => {
          const next = [...prev, row];
          persistLocal(next);
          return next;
        });
        return row;
      }

      const { data, error } = await supabase
        .from("fitness_routines")
        .insert({ user_id: userId, discipline, name, category: name, sort_order: sortOrder })
        .select()
        .single();
      if (error || !data) return null;

      const insertedRoutine = data as Record<string, unknown>;
      let insertedExercises: FitnessExercise[] = [];
      if (exercises.length) {
        const { data: exData } = await supabase
          .from("fitness_routine_exercises")
          .insert(
            exercises.map((ex, i) => ({
              routine_id: insertedRoutine.id,
              user_id: userId,
              name: ex.name ?? "",
              sets: ex.sets ?? null,
              reps: ex.reps ?? null,
              weight: ex.weight ?? null,
              rest: ex.rest ?? null,
              sort_order: i,
            })),
          )
          .select();
        insertedExercises = (exData as FitnessExercise[] | null) ?? [];
      }

      const newRoutine: FitnessRoutine = {
        id: insertedRoutine.id as string,
        user_id: insertedRoutine.user_id as string,
        discipline: insertedRoutine.discipline as FitnessDiscipline,
        name: insertedRoutine.name as string,
        category: insertedRoutine.category as string,
        sort_order: insertedRoutine.sort_order as number,
        created_at: insertedRoutine.created_at as string,
        updated_at: insertedRoutine.updated_at as string,
        exercises: insertedExercises,
      };
      setRoutines((prev) => [...prev, newRoutine]);
      return newRoutine;
    },
    [routines, useLocal, userId, discipline, supabase, persistLocal],
  );

  const updateRoutine = useCallback(
    async (id: string, patch: Partial<Pick<FitnessRoutine, "name" | "category">>) => {
      setRoutines((prev) => {
        const next = prev.map((r) => (r.id === id ? { ...r, ...patch, updated_at: nowISO() } : r));
        if (useLocal || !userId) persistLocal(next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase.from("fitness_routines").update({ ...patch, updated_at: nowISO() }).eq("id", id);
    },
    [useLocal, userId, supabase, persistLocal],
  );

  const removeRoutine = useCallback(
    async (id: string) => {
      setRoutines((prev) => {
        const next = prev.filter((r) => r.id !== id);
        if (useLocal || !userId) persistLocal(next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase.from("fitness_routines").delete().eq("id", id);
    },
    [useLocal, userId, supabase, persistLocal],
  );

  const addExercise = useCallback(
    async (routineId: string, exercise: NewExercise = {}) => {
      const routine = routines.find((r) => r.id === routineId);
      const sortOrder = routine ? routine.exercises.length : 0;
      const now = nowISO();

      if (useLocal || !userId) {
        const row: FitnessExercise = {
          id: uid(),
          routine_id: routineId,
          user_id: userId ?? "demo",
          name: exercise.name ?? "New exercise",
          sets: exercise.sets ?? null,
          reps: exercise.reps ?? null,
          weight: exercise.weight ?? null,
          rest: exercise.rest ?? null,
          sort_order: sortOrder,
          created_at: now,
          updated_at: now,
        };
        setRoutines((prev) => {
          const next = prev.map((r) => (r.id === routineId ? { ...r, exercises: [...r.exercises, row] } : r));
          persistLocal(next);
          return next;
        });
        return row;
      }

      const { data, error } = await supabase
        .from("fitness_routine_exercises")
        .insert({
          routine_id: routineId,
          user_id: userId,
          name: exercise.name ?? "New exercise",
          sets: exercise.sets ?? null,
          reps: exercise.reps ?? null,
          weight: exercise.weight ?? null,
          rest: exercise.rest ?? null,
          sort_order: sortOrder,
        })
        .select()
        .single();
      if (error || !data) return null;
      const row = data as FitnessExercise;
      setRoutines((prev) => prev.map((r) => (r.id === routineId ? { ...r, exercises: [...r.exercises, row] } : r)));
      return row;
    },
    [routines, useLocal, userId, supabase, persistLocal],
  );

  const updateExercise = useCallback(
    async (routineId: string, exerciseId: string, patch: Partial<NewExercise>) => {
      setRoutines((prev) => {
        const next = prev.map((r) =>
          r.id === routineId
            ? {
                ...r,
                exercises: r.exercises.map((ex) =>
                  ex.id === exerciseId ? { ...ex, ...patch, updated_at: nowISO() } : ex,
                ),
              }
            : r,
        );
        if (useLocal || !userId) persistLocal(next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase
        .from("fitness_routine_exercises")
        .update({ ...patch, updated_at: nowISO() })
        .eq("id", exerciseId);
    },
    [useLocal, userId, supabase, persistLocal],
  );

  const removeExercise = useCallback(
    async (routineId: string, exerciseId: string) => {
      setRoutines((prev) => {
        const next = prev.map((r) =>
          r.id === routineId ? { ...r, exercises: r.exercises.filter((ex) => ex.id !== exerciseId) } : r,
        );
        if (useLocal || !userId) persistLocal(next);
        return next;
      });
      if (useLocal || !userId) return;
      await supabase.from("fitness_routine_exercises").delete().eq("id", exerciseId);
    },
    [useLocal, userId, supabase, persistLocal],
  );

  /** Replace all routines for this discipline with an AI-generated plan (e.g. from AIRegimenModal). */
  const applyPlan = useCallback(
    async (plans: Array<{ name: string; exercises: NewExercise[] }>) => {
      // Remove existing routines for this discipline, then add the new ones.
      for (const r of routines) {
        await removeRoutine(r.id);
      }
      for (const p of plans) {
        await addRoutine(p.name, p.exercises);
      }
    },
    [routines, removeRoutine, addRoutine],
  );

  return {
    routines,
    loading,
    persistence: useLocal ? ("local" as const) : ("supabase" as const),
    signedIn: !!userId,
    refresh,
    addRoutine,
    updateRoutine,
    removeRoutine,
    addExercise,
    updateExercise,
    removeExercise,
    applyPlan,
  };
}
