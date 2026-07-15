import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_LOCATION } from "@/lib/geo/default-location";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { logRouteTiming } from "@/lib/observability/providerTiming";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  shouldCaptureWidgetEndpointStatus,
  widgetEndpointErrorCode,
  widgetProviderFailureTags,
} from "@/lib/widgets/observability";
import {
  dedupeWidgetIds,
  cachedWidgetRowToBatchWidget,
  maxWidgetsPerBatch,
  safeWidgetBatchError,
  statusForWidgetPayload,
  type BatchWidgetError,
  type BatchWidget,
  type WidgetPayload,
  widgetProviderTimeoutMs,
} from "@/lib/widgets/batch";
import type { WidgetCacheRow } from "@/lib/widgets/cache";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetDataSource } from "@/lib/widgets/types";

const route = "/api/widgets/batch";

const batchSchema = z.object({
  widgetIds: z.array(z.string().min(1).max(64)).min(1).max(maxWidgetsPerBatch),
  location: z.object({
    lat: z.number().finite(),
    lon: z.number().finite(),
    name: z.string().min(1).max(120).optional(),
  }).optional(),
});

type FetchWidgetResult = {
  id: string;
  widget?: BatchWidget;
  error?: BatchWidgetError;
};

function endpointFor(source: WidgetDataSource) {
  return source.endpoint;
}

function queryForWidget(req: Request, source: WidgetDataSource, location: z.infer<typeof batchSchema>["location"]) {
  const url = new URL(endpointFor(source) ?? "/", req.url);
  if (source.requiresLocation) {
    url.searchParams.set("lat", String(location?.lat ?? DEFAULT_LOCATION.lat));
    url.searchParams.set("lon", String(location?.lon ?? DEFAULT_LOCATION.lon));
    url.searchParams.set("name", location?.name ?? DEFAULT_LOCATION.name);
  }
  return url;
}

async function fetchWidget(
  req: Request,
  id: string,
  location: z.infer<typeof batchSchema>["location"],
  fetchedAt: string,
): Promise<FetchWidgetResult> {
  const definition = getWidgetDefinition(id);
  if (!definition) {
    return {
      id,
      error: safeWidgetBatchError("UNKNOWN_WIDGET", "Widget is not registered", false, 400),
    };
  }

  const endpoint = endpointFor(definition.source);
  if (!endpoint) {
    return {
      id,
      widget: {
        id,
        status: definition.statusDefault,
        value: definition.label,
        hint: "No live endpoint configured",
        fetchedAt,
        source: definition.source,
      } satisfies BatchWidget,
    };
  }

  try {
    const url = queryForWidget(req, definition.source, location);
    const res = await fetch(url, {
      headers: { cookie: req.headers.get("cookie") ?? "" },
      signal: AbortSignal.timeout(widgetProviderTimeoutMs(definition.source.provider)),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = widgetEndpointErrorCode(res.status);
      const error = safeWidgetBatchError(
        code,
        res.status === 401 ? "Unauthorized" : "Widget endpoint failed",
        res.status >= 500,
        res.status,
      );
      const safeTags = widgetProviderFailureTags({
        widget: id,
        provider: definition.source.provider,
        status: res.status,
        code,
      });
      if (shouldCaptureWidgetEndpointStatus(res.status)) {
        captureRouteError(new Error(`${definition.id} widget endpoint failed`), {
          route,
          operation: "fetch_widget",
          area: "widgets",
          provider: definition.source.provider,
          status: res.status,
          code: error.code,
          tags: safeTags,
        });
      } else {
        Sentry.addBreadcrumb({
          category: "widget.batch",
          level: "warning",
          message: "Widget endpoint returned non-ok",
          data: safeTags,
        });
      }
      return { id, error };
    }

    const payload = json as WidgetPayload;
    return {
      id,
      widget: {
        id,
        status: statusForWidgetPayload(payload, definition.statusDefault),
        value: payload.value ?? definition.label,
        hint: payload.hint ?? "",
        raw: payload.raw,
        fallback: Boolean(payload.fallback),
        fetchedAt,
        source: definition.source,
      } satisfies BatchWidget,
    };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const batchError = safeWidgetBatchError(
      timeout ? "PROVIDER_TIMEOUT" : "WIDGET_FETCH_FAILED",
      timeout ? "Widget provider timed out" : "Widget fetch failed",
      true,
      timeout ? 504 : undefined,
    );
    captureRouteError(error, {
      route,
      operation: "fetch_widget",
      area: "widgets",
      provider: definition.source.provider,
      status: batchError.status,
      code: batchError.code,
      tags: widgetProviderFailureTags({
        widget: id,
        provider: definition.source.provider,
        status: batchError.status,
        code: batchError.code,
      }),
    });
    return { id, error: batchError };
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid widget batch request", code: "INVALID_QUERY" },
      { status: 400 },
    );
  }

  const fetchedAt = new Date().toISOString();
  const widgetIds = dedupeWidgetIds(parsed.data.widgetIds);
  const results = await Promise.all(widgetIds.map((id) => fetchWidget(req, id, parsed.data.location, fetchedAt)));
  const widgets: Record<string, BatchWidget> = {};
  const errors: Record<string, BatchWidgetError> = {};
  const freshWidgetIds = new Set<string>();

  for (const result of results) {
    if (result.widget) {
      widgets[result.id] = result.widget;
      freshWidgetIds.add(result.id);
    }
    if (result.error) errors[result.id] = result.error;
  }

  const failedWidgetIds = Object.keys(errors).filter((id) => !widgets[id]);
  if (failedWidgetIds.length > 0) {
    const { data: cachedRows, error: cacheReadError } = await supabase
      .from("widget_cache")
      .select("widget_id,cache_key,status,value,hint,raw,error,fetched_at,expires_at")
      .in("widget_id", failedWidgetIds);
    if (cacheReadError) {
      captureRouteError(cacheReadError, {
        route,
        operation: "read_cache_fallback",
        area: "widgets",
        provider: "supabase",
        code: cacheReadError.code,
      });
    } else {
      for (const row of (cachedRows ?? []) as WidgetCacheRow[]) {
        if (widgets[row.widget_id]) continue;
        const cachedWidget = cachedWidgetRowToBatchWidget(row);
        if (cachedWidget) widgets[row.widget_id] = cachedWidget;
      }
    }
  }

  const cacheRows = Object.values(widgets).filter((widget) => freshWidgetIds.has(widget.id)).map((widget) => {
    const definition = getWidgetDefinition(widget.id);
    const staleAfterSeconds = definition?.freshness.staleAfterSeconds ?? 15 * 60;
    const expiresAt = staleAfterSeconds > 0
      ? new Date(new Date(widget.fetchedAt).getTime() + staleAfterSeconds * 1000).toISOString()
      : null;
    return {
      user_id: user.id,
      widget_id: widget.id,
      cache_key: widget.source.cacheKey,
      status: widget.status,
      value: widget.value,
      hint: widget.hint,
      raw: widget.raw ?? {},
      error: null,
      fetched_at: widget.fetchedAt,
      expires_at: expiresAt,
      updated_at: fetchedAt,
    };
  });

  if (cacheRows.length > 0) {
    const { error: cacheError } = await supabase
      .from("widget_cache")
      .upsert(cacheRows as Database["public"]["Tables"]["widget_cache"]["Insert"][], { onConflict: "user_id,widget_id,cache_key" });
    if (cacheError) {
      captureRouteError(cacheError, {
        route,
        operation: "write_cache",
        area: "widgets",
        provider: "supabase",
        code: cacheError.code,
      });
    }
  }

  logRouteTiming(route, startedAt, {
    requested: widgetIds.length,
    succeeded: Object.keys(widgets).length,
    failed: Object.keys(errors).length,
  });

  return NextResponse.json({
    fetchedAt,
    widgets,
    errors,
  });
}
