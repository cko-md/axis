import { ComposioError } from "./composio";
import {
  executeVerifiedComposioTool,
  listAuthorizedComposioConnections,
} from "./composio-identity";
import type { StravaActivity, StravaAthlete } from "@/app/api/strava/_lib";

export type ComposioStravaConnection = {
  /** Opaque Axis-owned connection identifier. Never a Composio account id. */
  connectionId: string;
};

export async function getComposioStravaConnection(userId: string): Promise<ComposioStravaConnection | null> {
  const [connection] = await listAuthorizedComposioConnections(userId, ["strava"]);
  return connection ? { connectionId: connection.id } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeComposioActivity(raw: Record<string, unknown>): StravaActivity | null {
  const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const startDate = typeof raw.start_date === "string" ? raw.start_date : typeof raw.start_date_local === "string" ? raw.start_date_local : null;
  if (!startDate || typeof raw.distance !== "number" || typeof raw.moving_time !== "number"
    || typeof raw.total_elevation_gain !== "number" || typeof raw.average_speed !== "number" || typeof raw.max_speed !== "number") return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "Activity",
    type: typeof raw.type === "string" ? raw.type : typeof raw.sport_type === "string" ? raw.sport_type : "Workout",
    sport_type: typeof raw.sport_type === "string" ? raw.sport_type : typeof raw.type === "string" ? raw.type : "Workout",
    start_date: startDate,
    distance: raw.distance,
    moving_time: raw.moving_time,
    elapsed_time: typeof raw.elapsed_time === "number" ? raw.elapsed_time : raw.moving_time,
    total_elevation_gain: raw.total_elevation_gain,
    average_speed: raw.average_speed,
    max_speed: raw.max_speed,
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
  connectionId: string,
  userId: string,
): Promise<StravaAthlete | null> {
  const res = await executeVerifiedComposioTool({
    toolSlug: "STRAVA_GET_AUTHENTICATED_ATHLETE",
    connectionId,
    toolkit: "strava",
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
  connectionId: string,
  userId: string,
): Promise<StravaActivity[]> {
  const res = await executeVerifiedComposioTool({
    toolSlug: "STRAVA_LIST_ATHLETE_ACTIVITIES",
    connectionId,
    toolkit: "strava",
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
