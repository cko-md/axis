import { NextResponse } from "next/server";
import { formatDaylight } from "@/lib/daylight";
import { parseGeoQuery } from "@/lib/geo/default-location";
import { createClient } from "@/lib/supabase/server";

/** "2026-06-12T05:21" (already local to the queried coords) → "5:21 AM" */
function localLabel(iso: string) {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function minusMinutes(iso: string, minutes: number) {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  const total = (h * 60 + m - minutes + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${iso.slice(0, 11)}${hh}:${mm}`;
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const geo = parseGeoQuery(new URL(req.url).searchParams);

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.lat));
    url.searchParams.set("longitude", String(geo.lon));
    url.searchParams.set("daily", "sunrise,sunset,daylight_duration");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("Daylight API failed");
    const data = await res.json();
    const sunrise = data.daily?.sunrise?.[0] as string | undefined;
    const sunset = data.daily?.sunset?.[0] as string | undefined;
    const daylightMs = ((data.daily?.daylight_duration?.[0] as number | undefined) ?? 0) * 1000;
    if (!sunrise || !sunset) throw new Error("Missing sun times");

    const golden = minusMinutes(sunset, 45);
    return NextResponse.json(
      { value: formatDaylight(daylightMs), hint: `Sunset ${localLabel(sunset)} · golden hour ${localLabel(golden)}`, raw: { sunrise, sunset, daylightMs } },
      { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch {
    return NextResponse.json(
      { value: "Daylight unavailable", hint: `${geo.name} · could not reach sun-times API`, fallback: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
