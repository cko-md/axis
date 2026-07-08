import { createClient } from "@/lib/supabase/server";
import { executeTool, ComposioError } from "./composio";
import type { StravaActivity, StravaAthlete } from "@/app/api/strava/_lib";

export type ComposioStravaConnection = {
  connectedAccountId: string;
};

export async function getComposioStravaConnection(userId: string): Promise<ComposioStravaConnection | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("composio_connections")
    .select("connected_account_id")
    .eq("user_id", userId)
    .eq("toolkit", "strava")
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (error || !data?.connected_account_id) return null;
  return { connectedAccountId: data.connected_account_id as string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeComposioActivity(raw: Record<string, unknown>): StravaActivity | null {
  const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "Activity",
    type: typeof raw.type === "string" ? raw.type : typeof raw.sport_type === "string" ? raw.sport_type : "Workout",
    sport_type: typeof raw.sport_type === "string" ? raw.sport_type : typeof raw.type === "string" ? raw.type : "Workout",
    start_date: typeof raw.start_date === "string" ? raw.start_date : typeof raw.start_date_local === "string" ? raw.start_date_local : new Date().toISOString(),
    distance: typeof raw.distance === "number" ? raw.distance : 0,
    moving_time: typeof raw.moving_time === "number" ? raw.moving_time : 0,
    elapsed_time: typeof raw.elapsed_time === "number" ? raw.elapsed_time : typeof raw.moving_time === "number" ? raw.moving_time : 0,
    total_elevation_gain: typeof raw.total_elevation_gain === "number" ? raw.total_elevation_gain : 0,
    average_speed: typeof raw.average_speed === "number" ? raw.average_speed : 0,
    max_speed: typeof raw.max_speed === "number" ? raw.max_speed : 0,
    average_heartrate: typeof raw.average_heartrate === "number" ? raw.average_heartrate : undefined,
    max_heartrate: typeof raw.max_heartrate === "number" ? raw.max_heartrate : undefined,
    suffer_score: typeof raw.suffer_score === "number" ? raw.suffer_score : undefined,
    kudos_count: typeof raw.kudos_count === "number" ? raw.kudos_count : undefined,
    achievement_count: typeof raw.achievement_count === "number" ? raw.achievement_count : undefined,
    pr_count: typeof raw.pr_count === "number" ? raw.pr_count : undefined,
    map: asRecord(raw.map)?.summary_polyline
      ? { summary_polyline: String(asRecord(raw.map)!.summary_polyline) }
      : undefined,
  };
}

export async function getComposioStravaAthlete(
  connectedAccountId: string,
  userId: string,
): Promise<StravaAthlete | null> {
  const res = await executeTool({
    toolSlug: "STRAVA_GET_AUTHENTICATED_ATHLETE",
    connectedAccountId,
    userId,
    arguments: {},
  });
  if (!res.successful) return null;
  const raw = asRecord(res.data) ?? {};
  const athlete = asRecord(raw.athlete) ?? raw;
  const id = typeof athlete.id === "number" ? athlete.id : Number(athlete.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    firstname: typeof athlete.firstname === "string" ? athlete.firstname : "Strava",
    lastname: typeof athlete.lastname === "string" ? athlete.lastname : "Athlete",
    profile: typeof athlete.profile === "string" ? athlete.profile : "",
  };
}

export async function listComposioStravaActivities(
  connectedAccountId: string,
  userId: string,
): Promise<StravaActivity[]> {
  const res = await executeTool({
    toolSlug: "STRAVA_LIST_ATHLETE_ACTIVITIES",
    connectedAccountId,
    userId,
    arguments: { per_page: 20, page: 1 },
  });
  if (!res.successful) {
    throw new ComposioError(res.error ?? "Strava activities fetch failed", 502);
  }
  const data = res.data as Record<string, unknown>;
  const items = (Array.isArray(data) ? data : (data.items ?? data.activities ?? data.data ?? [])) as unknown[];
  return items
    .map((item) => normalizeComposioActivity(asRecord(item) ?? {}))
    .filter((activity): activity is StravaActivity => activity !== null);
}
