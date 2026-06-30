"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_LOCATION, type GeoLocation } from "@/lib/geo/default-location";
import { getWidgetById } from "@/lib/store/widgets";
import { createClient } from "@/lib/supabase/client";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetDataSource, WidgetStatus } from "@/lib/widgets/types";

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

/** Outcome of the last geolocation request — lets callers surface denial/
 *  unavailability to the user instead of silently sitting on the fallback. */
export type GeoStatus = "idle" | "pending" | "granted" | "denied" | "unavailable";

const FETCHERS: Record<string, string> = {
  weather: "/api/widgets/weather",
  daylight: "/api/widgets/daylight",
  agenda: "/api/widgets/agenda",
  air: "/api/widgets/air-quality",
  markets: "/api/widgets/markets",
  run: "/api/widgets/training",
};

type WidgetCacheRow = {
  widget_id: string;
  status: WidgetStatus;
  value: string | null;
  hint: string | null;
  raw: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  fetched_at: string;
  expires_at: string | null;
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

type BatchResponse = {
  fetchedAt: string;
  widgets: Record<string, BatchWidget>;
  errors: Record<string, { code: string; message: string; retryable: boolean; status?: number }>;
};

function staleHint(hint: string) {
  return hint.endsWith(" · refresh failed") ? hint : `${hint} · refresh failed`;
}

function isStale(expiresAt: string | null) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= Date.now();
}

function cacheRowToWidgetData(row: WidgetCacheRow): WidgetData {
  const fallback = getWidgetById(row.widget_id);
  return {
    v: row.value ?? fallback.value,
    k: row.hint ?? fallback.hint,
    raw: row.raw ?? undefined,
    error: row.status === "error" || Boolean(row.error),
    stale: isStale(row.expires_at) || row.status === "stale",
    fallback: row.status === "setup_required" || row.status === "lab" || row.status === "disconnected",
    loading: false,
    updatedAt: row.fetched_at,
  };
}

function batchWidgetToData(widget: BatchWidget): WidgetData {
  return {
    v: widget.value,
    k: widget.hint,
    raw: widget.raw,
    fallback: Boolean(widget.fallback),
    error: widget.status === "error",
    stale: widget.status === "stale",
    loading: false,
    updatedAt: widget.fetchedAt,
  };
}

function uniqueWidgetIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function useWidgetData(widgetIds: string[], locationEnabled = false) {
  const [data, setData] = useState<Record<string, WidgetData>>({});
  const supabase = useMemo(() => createClient(), []);
  const widgetKey = widgetIds.join("|");
  const geoRef = useRef<GeoLocation>(DEFAULT_LOCATION);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  // Bumped whenever geolocation resolves so the fetch effect below re-runs
  // with the real coordinates instead of leaving widgets stuck on the
  // DEFAULT_LOCATION fallback they fetched with on first mount.
  const [geoVersion, setGeoVersion] = useState(0);

  useEffect(() => {
    if (!locationEnabled) {
      setGeoStatus("idle");
      return;
    }
    if (!navigator.geolocation) {
      setGeoStatus("unavailable");
      return;
    }
    setGeoStatus("pending");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        geoRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Your location" };
        setGeoStatus("granted");
        setGeoVersion((v) => v + 1);
      },
      (err) => {
        // Denied or otherwise unavailable — fall back to DEFAULT_LOCATION
        // (geoRef.current is already seeded with it) but report *why*, so
        // the caller can tell the user instead of failing silently.
        geoRef.current = DEFAULT_LOCATION;
        setGeoStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
      },
      { timeout: 5000 },
    );
  }, [locationEnabled]);

  useEffect(() => {
    let cancelled = false;
    const ids = uniqueWidgetIds(widgetIds);
    if (ids.length === 0) return;

    supabase
      .from("widget_cache")
      .select("widget_id,status,value,hint,raw,error,fetched_at,expires_at")
      .in("widget_id", ids)
      .then(({ data: rows }) => {
        if (cancelled || !rows?.length) return;
        setData((current) => {
          const next = { ...current };
          for (const row of rows as WidgetCacheRow[]) {
            next[row.widget_id] = cacheRowToWidgetData(row);
          }
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [supabase, widgetKey, widgetIds]);

  const refreshBatch = useCallback(
    async (ids: string[], signal?: AbortSignal) => {
      const requestedIds = uniqueWidgetIds(ids);
      if (requestedIds.length === 0) return;
      const batchIds = requestedIds.filter((id) => {
        const definition = getWidgetDefinition(id);
        return Boolean(definition?.source.endpoint ?? FETCHERS[id]);
      });
      const localIds = requestedIds.filter((id) => !batchIds.includes(id));
      setData((d) => {
        const next = { ...d };
        for (const id of localIds) {
          const fallback = getWidgetById(id);
          next[id] = { v: fallback.value, k: fallback.hint, loading: false };
        }
        for (const id of batchIds) {
          const previous = d[id];
          next[id] = previous
            ? { ...previous, loading: true }
            : { v: "…", k: "Loading", loading: true };
        }
        return next;
      });
      if (batchIds.length === 0) return;
      try {
        const geo = geoRef.current;
        const res = await fetch("/api/widgets/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            widgetIds: batchIds,
            location: { lat: geo.lat, lon: geo.lon, name: geo.name },
          }),
          signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? "Widget batch failed");
        const payload = json as BatchResponse;
        setData((d) => {
          const next = { ...d };
          for (const [id, widget] of Object.entries(payload.widgets ?? {})) {
            next[id] = batchWidgetToData(widget);
          }
          for (const id of batchIds) {
            if (payload.widgets?.[id]) continue;
            if (!payload.errors?.[id]) continue;
            const previous = d[id];
            const fallback = getWidgetById(id);
            next[id] = {
              v: previous?.v ?? fallback.value,
              k: previous ? staleHint(previous.k) : staleHint(fallback.hint),
              raw: previous?.raw,
              fallback: previous?.fallback,
              error: true,
              stale: Boolean(previous),
              loading: false,
              updatedAt: previous?.updatedAt,
            };
          }
          return next;
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setData((d) => {
          const next = { ...d };
          for (const id of batchIds) {
            const previous = d[id];
            const fallback = getWidgetById(id);
            next[id] = {
              v: previous?.v ?? fallback.value,
              k: previous ? staleHint(previous.k) : staleHint(fallback.hint),
              raw: previous?.raw,
              fallback: previous?.fallback,
              error: true,
              stale: Boolean(previous),
              loading: false,
              updatedAt: previous?.updatedAt,
            };
          }
          return next;
        });
      }
    },
    [],
  );

  const refreshOne = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const definition = getWidgetDefinition(id);
      if (!definition && !FETCHERS[id]) {
        const w = getWidgetById(id);
        setData((d) => ({ ...d, [id]: { v: w.value, k: w.hint } }));
        return;
      }
      return refreshBatch([id], signal);
    },
    [refreshBatch],
  );

  const refreshAll = useCallback((signal?: AbortSignal) => {
    return refreshBatch(widgetIds, signal);
  }, [widgetIds, refreshBatch]);

  useEffect(() => {
    const controller = new AbortController();
    refreshAll(controller.signal);
    const intervalId = setInterval(() => {
      const c = new AbortController();
      refreshAll(c.signal);
    }, 15 * 60 * 1000);
    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
    // geoVersion is intentionally included: it bumps once real GPS coordinates
    // land (see the geolocation effect above), so location-dependent widgets
    // that already fetched against DEFAULT_LOCATION on mount get refetched
    // with the user's actual position instead of silently keeping the stub.
  }, [refreshAll, geoVersion]);

  return { data, refreshOne, refreshAll, geoStatus };
}
