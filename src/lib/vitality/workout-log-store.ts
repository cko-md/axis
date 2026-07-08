import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkoutLog } from "@/lib/vitality/workout-log";

type WorkoutLogRow = {
  log: WorkoutLog;
  session_id: string;
  user_id: string;
  logged_at: string;
  updated_at: string;
};

/** Untyped access until Database types include workout_logs (050_workout_logs.sql). */
function workoutLogsDb(supabase: SupabaseClient) {
  return supabase as unknown as {
    from(table: "workout_logs"): {
      select(cols: string): {
        eq(col: string, val: string): {
          eq(col: string, val: string): {
            maybeSingle(): Promise<{ data: Pick<WorkoutLogRow, "log"> | null; error: { message: string } | null }>;
          };
        };
      };
      upsert(
        row: Partial<WorkoutLogRow>,
        opts: { onConflict: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
}

export async function loadWorkoutLog(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
): Promise<{ log: WorkoutLog | null; error: string | null }> {
  const { data, error } = await workoutLogsDb(supabase)
    .from("workout_logs")
    .select("log")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) return { log: null, error: error.message };
  if (!data?.log || typeof data.log !== "object") return { log: null, error: null };
  return { log: { ...(data.log as WorkoutLog), sessionId }, error: null };
}

export async function saveWorkoutLog(
  supabase: SupabaseClient,
  userId: string,
  log: WorkoutLog,
): Promise<{ error: string | null }> {
  const { error } = await workoutLogsDb(supabase)
    .from("workout_logs")
    .upsert(
      {
        user_id: userId,
        session_id: log.sessionId,
        log,
        logged_at: log.loggedAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,session_id" },
    );
  return { error: error?.message ?? null };
}
