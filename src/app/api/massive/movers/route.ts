import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchMovers, getPolygonApiKey } from "@/lib/massive/client";

const querySchema = z.object({
  direction: z.enum(["gainers", "losers"]).default("gainers"),
});

export async function GET(request: NextRequest) {
  if (!getPolygonApiKey()) {
    return NextResponse.json(
      { error: "POLYGON_API_KEY_NOT_CONFIGURED", message: "Set POLYGON_API_KEY to enable movers." },
      { status: 503 },
    );
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_QUERY", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const movers = await fetchMovers(parsed.data.direction);
    return NextResponse.json({ direction: parsed.data.direction, movers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
