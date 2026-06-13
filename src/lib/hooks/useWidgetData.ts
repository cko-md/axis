"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_LOCATION, type GeoLocation } from "@/lib/geo/default-location";
import { getWidgetById } from "@/lib/store/widgets";

export type WidgetData = { v: string; k: string; loading?: boolean };

const FETCHERS: Record<string, string> = {
  weather: "/api/widgets/weather",
  daylight: "/api/widgets/daylight",
  agenda: "/api/widgets/agenda",
  air: "/api/widgets/air-quality",
  markets: "/api/widgets/markets",
};

export function useWidgetData(widgetIds: string[]) {
  const [data, setData] = useState<Record<string, WidgetData>>({});
  const [geo, setGeo] = useState<GeoLocation>(DEFAULT_LOCATION);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Your location" }),
      () => {},
      { timeout: 5000 },
    );
  }, []);

  const refreshOne = useCallback(
    async (id: string) => {
      const w = getWidgetById(id);
      const path = FETCHERS[id];
      if (!path) {
        setData((d) => ({ ...d, [id]: { v: w.value, k: w.hint } }));
        return;
      }
      setData((d) => ({ ...d, [id]: { v: "…", k: "Loading", loading: true } }));
      try {
        const q = new URLSearchParams({ lat: String(geo.lat), lon: String(geo.lon), name: geo.name });
        const res = await fetch(`${path}?${q}`);
        const json = await res.json();
        setData((d) => ({ ...d, [id]: { v: json.value, k: json.hint } }));
      } catch {
        setData((d) => ({ ...d, [id]: { v: w.value, k: w.hint } }));
      }
    },
    [geo],
  );

  const refreshAll = useCallback(() => {
    widgetIds.forEach(refreshOne);
  }, [widgetIds, refreshOne]);

  useEffect(() => {
    refreshAll();
    const id = setInterval(refreshAll, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshAll]);

  return { data, refreshOne, refreshAll, geo };
}
