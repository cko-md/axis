import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_LOCATION } from "@/lib/geo/default-location";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { logRouteTiming } from "@/lib/observability/providerTiming";
import { createClient } from "@/lib/supabase/server";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetDataSource, WidgetStatus } from "@/lib/widgets/types";

const route = "/api/widgets/batch";
const maxWidgetsPerBatch = 24;

const batchSchema = z.object({
  widgetIds: z.array(z.string().min(1).max(64)).min(1).max(maxWidgetsPerBatch),
  location: z.object({
    lat: z.number().finite(),
    lon: z.number().finite(),
    name: z.string().min(1).max(120).optional(),
  }).optional(),
});

type WidgetPayload = {
  value?: string;
  hint?: string;
  raw?: Record<string, unknown>;
  fallback?: boolean;
  error?: boolean;
  partial?: boolean;
};

type BatchWidget = {
  id: string;
  status: WidgetStatus;
  value: string;
  hint: string;
  raw?: Record<string, unknown>;
  fallback?: boolean;
  fetchedAt: string;
  source: WidgetDataSource;
};

type BatchWidgetError = {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
};

type FetchWidgetResult = {
  id: string;
  widget?: BatchWidget;
  error?: BatchWidgetError;
};

function dedupe(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, maxWidgetsPerBatch);
}

function endpointFor(source: WidgetDataSource) {
  return source.endpoint;
}

function statusForPayload(payload: WidgetPayload, defaultStatus: WidgetStatus): WidgetStatus {
  if (payload.error) return "error";
  if (payload.partial) return "stale";
  if (payload.fallback) return defaultStatus;
  return "fresh";
}

function providerTimeoutMs(provider: WidgetDataSource["provider"]) {
  if (provider === "open-meteo") return 4_500;
  if (provider === "polygon" || provider === "massive" || provider === "strava") return 5_500;
  if (provider === "supabase") return 3_000;
  return 2_000;
}

function safeError(code: string, message: string, retryable: boolean, status?: number): BatchWidgetError {
  return { code, message, retryable, ...(status !== undefined ? { status } : {}) };
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
      error: safeError("UNKNOWN_WIDGET", "Widget is not registered", false, 400),
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
      signal: AbortSignal.timeout(providerTimeoutMs(definition.source.provider)),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = safeError(
        res.status === 401 ? "UNAUTHORIZED" : "WIDGET_ENDPOINT_FAILED",
        res.status === 401 ? "Unauthorized" : "Widget endpoint failed",
        res.status >= 500,
        res.status,
      );
      if (res.status >= 500) {
        captureRouteError(new Error(`${definition.id} widget endpoint failed`), {
          route,
          operation: "fetch_widget",
          area: "widgets",
          provider: definition.source.provider,
          status: res.status,
          code: error.code,
          tags: { widget: id },
        });
      } else {
        Sentry.addBreadcrumb({
          category: "widget.batch",
          level: "warning",
          message: "Widget endpoint returned non-ok",
          data: { widget: id, provider: definition.source.provider, status: res.status },
        });
      }
      return { id, error };
    }

    const payload = json as WidgetPayload;
    return {
      id,
      widget: {
        id,
        status: statusForPayload(payload, definition.statusDefault),
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
    const batchError = safeError(
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
      tags: { widget: id },
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
  const widgetIds = dedupe(parsed.data.widgetIds);
  const results = await Promise.all(widgetIds.map((id) => fetchWidget(req, id, parsed.data.location, fetchedAt)));
  const widgets: Record<string, BatchWidget> = {};
  const errors: Record<string, BatchWidgetError> = {};

  for (const result of results) {
    if (result.widget) widgets[result.id] = result.widget;
    if (result.error) errors[result.id] = result.error;
  }

  const cacheRows = Object.values(widgets).map((widget) => {
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
      .upsert(cacheRows, { onConflict: "user_id,widget_id,cache_key" });
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
