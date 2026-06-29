"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_LOCATION, type GeoLocation } from "@/lib/geo/default-location";
import { getWidgetById } from "@/lib/store/widgets";

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

function staleHint(hint: string) {
  return hint.endsWith(" · refresh failed") ? hint : `${hint} · refresh failed`;
}

export function useWidgetData(widgetIds: string[], locationEnabled = false) {
  const [data, setData] = useState<Record<string, WidgetData>>({});
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

  const refreshOne = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const w = getWidgetById(id);
      const path = FETCHERS[id];
      if (!path) {
        setData((d) => ({ ...d, [id]: { v: w.value, k: w.hint } }));
        return;
      }
      setData((d) => {
        const previous = d[id];
        return {
          ...d,
          [id]: previous
            ? { ...previous, loading: true }
            : { v: "…", k: "Loading", loading: true },
        };
      });
      try {
        const geo = geoRef.current;
        const q = new URLSearchParams({ lat: String(geo.lat), lon: String(geo.lon), name: geo.name });
        const res = await fetch(`${path}?${q}`, { signal });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `Widget ${id} failed`);
        const payload = json as { value?: string; hint?: string; raw?: Record<string, unknown>; fallback?: boolean; error?: boolean };
        setData((d) => ({
          ...d,
          [id]: {
            v: payload.value ?? w.value,
            k: payload.hint ?? w.hint,
            raw: payload.raw,
            fallback: !!payload.fallback,
            error: !!payload.error,
            stale: false,
            loading: false,
            updatedAt: new Date().toISOString(),
          },
        }));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setData((d) => {
          const previous = d[id];
          return {
            ...d,
            [id]: {
              v: previous?.v ?? w.value,
              k: previous ? staleHint(previous.k) : w.hint,
              raw: previous?.raw,
              fallback: previous?.fallback,
              error: true,
              stale: !!previous,
              loading: false,
              updatedAt: previous?.updatedAt,
            },
          };
        });
      }
    },
    // getWidgetById is a stable module-level import
    [],
  );

  const refreshAll = useCallback((signal?: AbortSignal) => {
    return Promise.all(widgetIds.map((id) => refreshOne(id, signal)));
  }, [widgetIds, refreshOne]);

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
