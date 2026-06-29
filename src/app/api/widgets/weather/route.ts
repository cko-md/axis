import { NextResponse } from "next/server";
import { parseGeoQuery } from "@/lib/geo/default-location";
import { createClient } from "@/lib/supabase/server";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";

export async function GET(req: Request) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const geo = parseGeoQuery(new URL(req.url).searchParams);
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.lat));
    url.searchParams.set("longitude", String(geo.lon));
    url.searchParams.set("current", "temperature_2m,weather_code,relative_humidity_2m");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", "auto");

    const res = await timedProviderFetch(
      url.toString(),
      {},
      { area: "console", provider: "open-meteo", operation: "weather", timeoutMs: 4_000, slowMs: 1_200 },
    );
    if (!res.ok) throw new Error("Weather API failed");
    const data = await res.json();
    const cur = data.current;
    const code = cur.weather_code as number;
    const label = weatherLabel(code);
    const temp = Math.round(cur.temperature_2m);
    const hour = new Date().getHours();
    const runHint =
      hour >= 6 && hour <= 9 ? "ideal run window 7–9a" : hour < 6 ? "pre-dawn · quiet hours" : "evening cool-down";

    logRouteTiming("/api/widgets/weather", routeStartedAt, { fallback: false });
    return NextResponse.json(
      { value: `${temp}°F · ${label}`, hint: `${geo.name} · ${runHint}`, raw: { temp, code, humidity: cur.relative_humidity_2m } },
      { headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=1800" } },
    );
  } catch {
    logRouteTiming("/api/widgets/weather", routeStartedAt, { fallback: true });
    return NextResponse.json(
      { value: "Weather unavailable", hint: `${geo.name} · refresh failed`, fallback: true, error: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

function weatherLabel(code: number) {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  return "Stormy";
}
