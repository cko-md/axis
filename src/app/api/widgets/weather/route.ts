import { NextResponse } from "next/server";
import { parseGeoQuery } from "@/lib/geo/default-location";

export async function GET(req: Request) {
  const geo = parseGeoQuery(new URL(req.url).searchParams);
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.lat));
    url.searchParams.set("longitude", String(geo.lon));
    url.searchParams.set("current", "temperature_2m,weather_code,relative_humidity_2m");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", "auto");

    const res = await fetch(url.toString(), { next: { revalidate: 900 } });
    if (!res.ok) throw new Error("Weather API failed");
    const data = await res.json();
    const cur = data.current;
    const code = cur.weather_code as number;
    const label = weatherLabel(code);
    const temp = Math.round(cur.temperature_2m);
    const hour = new Date().getHours();
    const runHint =
      hour >= 6 && hour <= 9 ? "ideal run window 7–9a" : hour < 6 ? "pre-dawn · quiet hours" : "evening cool-down";

    return NextResponse.json({
      value: `${temp}°F · ${label}`,
      hint: `${geo.name} · ${runHint}`,
      raw: { temp, code, humidity: cur.relative_humidity_2m },
    });
  } catch {
    return NextResponse.json({
      value: "61°F · Clear",
      hint: `${geo.name} · offline fallback`,
      fallback: true,
    });
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
