import { NextResponse } from "next/server";
import { getPolygonApiKey } from "@/lib/massive/client";

export async function GET() {
  const configured = !!getPolygonApiKey();
  return NextResponse.json({
    configured,
    linked: configured,
    source: configured ? "polygon" : "simulated",
    provider: "polygon",
    latestConnection: null,
    message: configured
      ? "Polygon API key is configured server-side."
      : "No POLYGON_API_KEY or MASSIVE_API_KEY set — using simulated data.",
  });
}
