import { NextResponse } from "next/server";
import { fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";

export async function GET() {
  if (!getPolygonApiKey()) {
    return NextResponse.json({
      value: "Markets offline",
      hint: "Set POLYGON_API_KEY for live quotes",
      fallback: true,
    });
  }

  try {
    const spy = await fetchSnapshot("SPY");
    const sign = spy.chg >= 0 ? "▴" : "▾";
    return NextResponse.json({
      value: `S&P ${sign}${Math.abs(spy.chg).toFixed(2)}%`,
      hint: "SPY · live via Massive",
      raw: spy,
    });
  } catch {
    return NextResponse.json({
      value: "Markets unavailable",
      hint: "Quote fetch failed — retry shortly",
      fallback: true,
    });
  }
}
