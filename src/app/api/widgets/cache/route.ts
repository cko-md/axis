import { z } from "zod";
import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { logRouteTiming } from "@/lib/observability/providerTiming";
import { createClient } from "@/lib/supabase/server";
import { dedupeWidgetIds, maxWidgetsPerBatch } from "@/lib/widgets/batch";
import {
  widgetCacheRowMatchesDefinition,
  type WidgetCacheRow,
} from "@/lib/widgets/cache";

const route = "/api/widgets/cache";
const cacheSchema = z.object({
  widgetIds: z.array(z.string().min(1).max(64)).min(1).max(maxWidgetsPerBatch),
});

export async function POST(req: Request) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  const body = await req.json().catch(() => null);
  const parsed = cacheSchema.safeParse(body);
  if (!parsed.success) {
    return privateJson(
      { error: "Invalid widget cache request", code: "INVALID_QUERY" },
      { status: 400 },
    );
  }
  const widgetIds = dedupeWidgetIds(parsed.data.widgetIds);
  const { data, error } = await supabase
    .from("widget_cache")
    .select("widget_id,cache_key,status,value,hint,raw,error,fetched_at,expires_at")
    .eq("user_id", user.id)
    .in("widget_id", widgetIds);
  if (error) {
    captureRouteError(error, {
      route,
      operation: "read_cache",
      area: "widgets",
      provider: "supabase",
      code: error.code,
    });
    return privateJson(
      { error: "WIDGET_CACHE_UNAVAILABLE" },
      { status: 502 },
    );
  }

  const rows = ((data ?? []) as WidgetCacheRow[]).filter(
    widgetCacheRowMatchesDefinition,
  );
  logRouteTiming(route, startedAt, {
    requested: widgetIds.length,
    returned: rows.length,
  });
  return privateJson({ rows });
}
