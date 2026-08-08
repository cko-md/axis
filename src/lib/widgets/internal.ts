import { GET as agendaWidget } from "@/app/api/widgets/agenda/route";
import { GET as airQualityWidget } from "@/app/api/widgets/air-quality/route";
import { GET as daylightWidget } from "@/app/api/widgets/daylight/route";
import { GET as marketsWidget } from "@/app/api/widgets/markets/route";
import { GET as trainingWidget } from "@/app/api/widgets/training/route";
import { GET as weatherWidget } from "@/app/api/widgets/weather/route";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import type { WidgetDataSource } from "@/lib/widgets/types";

type WidgetLocation = {
  lat?: number;
  lon?: number;
  name?: string;
};

type WidgetHandler = (request: Request) => Promise<Response> | Response;

const INTERNAL_ORIGIN = "https://axis.internal";

const handlers: Record<string, WidgetHandler> = {
  "/api/widgets/weather": weatherWidget,
  "/api/widgets/daylight": daylightWidget,
  "/api/widgets/air-quality": airQualityWidget,
  "/api/widgets/agenda": agendaWidget,
  "/api/widgets/markets": marketsWidget,
  "/api/widgets/training": trainingWidget,
};

/**
 * Invokes an allowlisted widget handler in-process. This is deliberately not a
 * server self-fetch: no incoming Host, Cookie, or other client headers are
 * copied, and the only constructed origin is a non-routable canonical marker.
 * Authentication remains in the current Next request context used by each
 * handler's server client.
 */
export async function invokeWidgetEndpoint(
  source: WidgetDataSource,
  location: WidgetLocation | undefined,
  authenticatedUserId: string,
) {
  const path = source.endpoint;
  if (!path) throw new Error("WIDGET_ENDPOINT_NOT_ALLOWLISTED");
  const handler = handlers[path];
  if (!handler) throw new Error("WIDGET_ENDPOINT_NOT_ALLOWLISTED");

  const url = new URL(path, INTERNAL_ORIGIN);
  if (source.requiresLocation) {
    if (location?.lat !== undefined) url.searchParams.set("lat", String(location.lat));
    if (location?.lon !== undefined) url.searchParams.set("lon", String(location.lon));
    if (location?.name) url.searchParams.set("name", location.name);
  }
  const headers = new Headers({
    [EXPECTED_PROFILE_SUBJECT_HEADER]: profileSubjectForUserId(authenticatedUserId),
  });
  return handler(new Request(url, { headers }));
}
