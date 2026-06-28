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
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.searchParams.set("latitude", String(geo.lat));
    url.searchParams.set("longitude", String(geo.lon));
    url.searchParams.set("current", "us_aqi,uv_index");

    const res = await timedProviderFetch(
      url.toString(),
      {},
      { area: "console", provider: "open-meteo", operation: "air_quality", timeoutMs: 4_000, slowMs: 1_200 },
    );
    if (!res.ok) throw new Error("AQ API failed");
    const data = await res.json();
    const aqi = Math.round(data.current.us_aqi ?? 0);
    const uv = Math.round(data.current.uv_index ?? 0);
    const label = aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" : "Poor";
    const uvHint = uv >= 6 ? "sunscreen for long run" : uv >= 3 ? "mild UV" : "low UV";

    logRouteTiming("/api/widgets/air-quality", routeStartedAt, { fallback: false });
    return NextResponse.json(
      { value: `AQI ${aqi} · ${label}`, hint: `UV ${uv} · ${uvHint}`, raw: { aqi, uv } },
      { headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch {
    logRouteTiming("/api/widgets/air-quality", routeStartedAt, { fallback: true });
    return NextResponse.json(
      { value: "Air unavailable", hint: `${geo.name} · refresh failed`, fallback: true, error: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
