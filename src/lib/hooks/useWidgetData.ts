"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountState } from "@/components/layout/ShellProfileContext";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";
import { DEFAULT_LOCATION, type GeoLocation } from "@/lib/geo/default-location";
import { getWidgetById } from "@/lib/store/widgets";
import {
  widgetRefreshFailureData,
  type WidgetData,
} from "@/lib/widgets/cache";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetDataSource, WidgetStatus } from "@/lib/widgets/types";

export type { WidgetData } from "@/lib/widgets/cache";

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

type WidgetAuthority = { subject: string; epoch: number };

export function useWidgetData(
  widgetIds: string[],
  locationEnabled = false,
  providerAuthority?: {
    subject: string | null;
    accountState: AccountState;
    authorityEpoch: number;
  },
) {
  const [data, setData] = useState<Record<string, WidgetData>>({});
  const geoRef = useRef<GeoLocation>(DEFAULT_LOCATION);
  const controllersRef = useRef(new Set<AbortController>());
  const authorityRef = useRef<WidgetAuthority | null>(null);
  const dataAuthorityRef = useRef<WidgetAuthority | null>(null);
  authorityRef.current = providerAuthority?.accountState === "ready" && providerAuthority.subject
    ? { subject: providerAuthority.subject, epoch: providerAuthority.authorityEpoch }
    : null;
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  // Bumped whenever geolocation resolves so the fetch effect below re-runs
  // with the real coordinates instead of leaving widgets stuck on the
  // DEFAULT_LOCATION fallback they fetched with on first mount.
  const [geoVersion, setGeoVersion] = useState(0);

  const isCurrent = useCallback((authority: WidgetAuthority) => {
    const current = authorityRef.current;
    return current?.subject === authority.subject && current.epoch === authority.epoch;
  }, []);

  const retireWidgetRequests = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    dataAuthorityRef.current = null;
  }, []);

  useEffect(() => {
    const authority = authorityRef.current;
    if (!authority) {
      setGeoStatus("idle");
      return;
    }
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
        if (!isCurrent(authority)) return;
        geoRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Your location" };
        setGeoStatus("granted");
        setGeoVersion((v) => v + 1);
      },
      (err) => {
        if (!isCurrent(authority)) return;
        // Denied or otherwise unavailable — fall back to DEFAULT_LOCATION
        // (geoRef.current is already seeded with it) but report *why*, so
        // the caller can tell the user instead of failing silently.
        geoRef.current = DEFAULT_LOCATION;
        setGeoStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
      },
      { timeout: 5000 },
    );
  }, [
    isCurrent,
    locationEnabled,
    providerAuthority?.accountState,
    providerAuthority?.authorityEpoch,
    providerAuthority?.subject,
  ]);

  useEffect(() => {
    retireWidgetRequests();
    setData({});
    geoRef.current = DEFAULT_LOCATION;
  }, [
    providerAuthority?.accountState,
    providerAuthority?.authorityEpoch,
    providerAuthority?.subject,
    retireWidgetRequests,
  ]);

  const refreshBatch = useCallback(
    async (ids: string[], signal?: AbortSignal) => {
      const requestedIds = uniqueWidgetIds(ids);
      if (requestedIds.length === 0) return;
      const authority = authorityRef.current;
      if (!authority) return;
      const batchIds = requestedIds.filter((id) => {
        const definition = getWidgetDefinition(id);
        return Boolean(definition?.source.endpoint ?? FETCHERS[id]);
      });
      const localIds = requestedIds.filter((id) => !batchIds.includes(id));
      if (!isCurrent(authority)) return;
      dataAuthorityRef.current = authority;
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
      const controller = new AbortController();
      controllersRef.current.add(controller);
      const abortFromCaller = () => controller.abort();
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      try {
        const geo = geoRef.current;
        const res = await subjectBoundFetch(authority.subject, "/api/widgets/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            widgetIds: batchIds,
            location: { lat: geo.lat, lon: geo.lon, name: geo.name },
          }),
          signal: controller.signal,
        });
        if (!isCurrent(authority) || controller.signal.aborted) return;
        const json = await res.json().catch(() => ({}));
        if (!isCurrent(authority) || controller.signal.aborted) return;
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
            next[id] = widgetRefreshFailureData(id, d[id]);
          }
          return next;
        });
      } catch {
        if (!isCurrent(authority) || controller.signal.aborted) return;
        setData((d) => {
          const next = { ...d };
          for (const id of batchIds) {
            next[id] = widgetRefreshFailureData(id, d[id]);
          }
          return next;
        });
      } finally {
        signal?.removeEventListener("abort", abortFromCaller);
        controllersRef.current.delete(controller);
      }
    },
    [isCurrent],
  );

  const refreshOne = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const definition = getWidgetDefinition(id);
      if (!definition && !FETCHERS[id]) {
        const authority = authorityRef.current;
        if (!authority) return;
        dataAuthorityRef.current = authority;
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
    if (!authorityRef.current) return;
    const controller = new AbortController();
    refreshAll(controller.signal);
    const intervalId = setInterval(() => {
      const c = new AbortController();
      refreshAll(c.signal);
    }, 15 * 60 * 1000);
    return () => {
      controller.abort();
      clearInterval(intervalId);
      retireWidgetRequests();
    };
    // geoVersion is intentionally included: it bumps once real GPS coordinates
    // land (see the geolocation effect above), so location-dependent widgets
    // that already fetched against DEFAULT_LOCATION on mount get refetched
    // with the user's actual position instead of silently keeping the stub.
  }, [
    geoVersion,
    providerAuthority?.accountState,
    providerAuthority?.authorityEpoch,
    providerAuthority?.subject,
    refreshAll,
    retireWidgetRequests,
  ]);

  const currentAuthority = authorityRef.current;
  const dataAuthority = dataAuthorityRef.current;
  const visibleData = currentAuthority && dataAuthority &&
    currentAuthority.subject === dataAuthority.subject &&
    currentAuthority.epoch === dataAuthority.epoch
    ? data
    : {};

  return { data: visibleData, refreshOne, refreshAll, geoStatus };
}
