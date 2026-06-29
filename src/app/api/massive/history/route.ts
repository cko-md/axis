import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchAggs, getPolygonApiKey } from "@/lib/massive/client";
import { logRouteTiming } from "@/lib/observability/providerTiming";

const querySchema = z.object({
  symbol: z.string().min(1).max(12),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: NextRequest) {
  const routeStartedAt = Date.now();
  if (!getPolygonApiKey()) {
    logRouteTiming("/api/massive/history", routeStartedAt, { configured: false });
    return NextResponse.json(
      {
        error: "POLYGON_API_KEY_NOT_CONFIGURED",
        message:
          "Set POLYGON_API_KEY or MASSIVE_API_KEY in your environment to enable live market data.",
      },
      { status: 503 },
    );
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    logRouteTiming("/api/massive/history", routeStartedAt, { ok: false, code: "INVALID_QUERY" });
    return NextResponse.json(
      { error: "INVALID_QUERY", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { symbol, from, to } = parsed.data;

  try {
    const bars = await fetchAggs(symbol.toUpperCase(), from, to);
    logRouteTiming("/api/massive/history", routeStartedAt, { ok: true, symbol: symbol.toUpperCase(), bars: bars.length });
    return NextResponse.json({ symbol: symbol.toUpperCase(), from, to, bars });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      e && typeof e === "object" && "status" in e
        ? Number((e as { status: number }).status)
        : 502;
    logRouteTiming("/api/massive/history", routeStartedAt, { ok: false, symbol: symbol.toUpperCase(), status });
    return NextResponse.json({ error: message }, { status });
  }
}
