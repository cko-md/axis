import { getWidgetById } from "@/lib/store/widgets";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetStatus } from "@/lib/widgets/types";

export type WidgetData = {
  v: string;
  k: string;
  loading?: boolean;
  error?: boolean;
  stale?: boolean;
  fallback?: boolean;
  updatedAt?: string;
  raw?: Record<string, unknown>;
};

export type WidgetCacheRow = {
  widget_id: string;
  cache_key: string;
  status: WidgetStatus;
  value: string | null;
  hint: string | null;
  raw: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  fetched_at: string;
  expires_at: string | null;
};

export function isWidgetCacheStale(expiresAt: string | null, now = Date.now()) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= now;
}

export function widgetCacheRowMatchesDefinition(row: Pick<WidgetCacheRow, "widget_id" | "cache_key">) {
  const definition = getWidgetDefinition(row.widget_id);
  return Boolean(definition && definition.source.cacheKey === row.cache_key);
}

export function widgetCacheRowToData(row: WidgetCacheRow, now = Date.now()): WidgetData {
  const fallback = getWidgetById(row.widget_id);
  return {
    v: row.value ?? fallback.value,
    k: row.hint ?? fallback.hint,
    raw: row.raw ?? undefined,
    error: row.status === "error" || Boolean(row.error),
    stale: isWidgetCacheStale(row.expires_at, now) || row.status === "stale",
    fallback: row.status === "setup_required" || row.status === "lab" || row.status === "disconnected",
    loading: false,
    updatedAt: row.fetched_at,
  };
}

export function widgetStaleHint(hint: string) {
  return hint.endsWith(" · refresh failed") ? hint : `${hint} · refresh failed`;
}

export function widgetRefreshFailureData(widgetId: string, previous?: WidgetData): WidgetData {
  const fallback = getWidgetById(widgetId);
  return {
    v: previous?.v ?? fallback.value,
    k: previous ? widgetStaleHint(previous.k) : widgetStaleHint(fallback.hint),
    raw: previous?.raw,
    fallback: previous?.fallback,
    error: true,
    stale: Boolean(previous),
    loading: false,
    updatedAt: previous?.updatedAt,
  };
}
