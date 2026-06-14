"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_LOCATION, type GeoLocation } from "@/lib/geo/default-location";
import { getWidgetById } from "@/lib/store/widgets";

export type WidgetData = { v: string; k: string; loading?: boolean; error?: boolean; raw?: Record<string, unknown> };

const FETCHERS: Record<string, string> = {
  weather: "/api/widgets/weather",
  daylight: "/api/widgets/daylight",
  agenda: "/api/widgets/agenda",
  air: "/api/widgets/air-quality",
  markets: "/api/widgets/markets",
};

export function useWidgetData(widgetIds: string[], locationEnabled = false) {
  const [data, setData] = useState<Record<string, WidgetData>>({});
  const geoRef = useRef<GeoLocation>(DEFAULT_LOCATION);

  useEffect(() => {
    if (!locationEnabled || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => { geoRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Your location" }; },
      () => {},
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
      setData((d) => ({ ...d, [id]: { v: "…", k: "Loading", loading: true } }));
      try {
        const geo = geoRef.current;
        const q = new URLSearchParams({ lat: String(geo.lat), lon: String(geo.lon), name: geo.name });
        const res = await fetch(`${path}?${q}`, { signal });
        const json = await res.json();
        setData((d) => ({ ...d, [id]: { v: json.value, k: json.hint, raw: json.raw } }));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setData((d) => ({ ...d, [id]: { v: w.value, k: w.hint, error: true } }));
      }
    },
    // getWidgetById is a stable module-level import
    [],
  );

  const refreshAll = useCallback((signal?: AbortSignal) => {
    widgetIds.forEach((id) => refreshOne(id, signal));
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
  }, [refreshAll]);

  return { data, refreshOne, refreshAll };
}
