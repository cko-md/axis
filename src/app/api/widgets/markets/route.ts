import { NextResponse } from "next/server";
import { fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { logRouteTiming } from "@/lib/observability/providerTiming";

export async function GET() {
  const routeStartedAt = Date.now();
  if (!getPolygonApiKey()) {
    logRouteTiming("/api/widgets/markets", routeStartedAt, { fallback: true, configured: false });
    return NextResponse.json({
      value: "Markets offline",
      hint: "Set POLYGON_API_KEY for live quotes",
      fallback: true,
    });
  }

  try {
    const spy = await fetchSnapshot("SPY");
    const sign = spy.chg >= 0 ? "▴" : "▾";
    logRouteTiming("/api/widgets/markets", routeStartedAt, { fallback: false });
    return NextResponse.json({
      value: `S&P ${sign}${Math.abs(spy.chg).toFixed(2)}%`,
      hint: "SPY · live via Massive",
      raw: spy,
    });
  } catch {
    logRouteTiming("/api/widgets/markets", routeStartedAt, { fallback: true, configured: true });
    return NextResponse.json({
      value: "Markets unavailable",
      hint: "Quote fetch failed — retry shortly",
      fallback: true,
    });
  }
}
