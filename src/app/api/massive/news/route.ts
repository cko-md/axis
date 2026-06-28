import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchNews, getPolygonApiKey } from "@/lib/massive/client";
import { logRouteTiming } from "@/lib/observability/providerTiming";

const querySchema = z.object({
  tickers: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export async function GET(request: NextRequest) {
  const routeStartedAt = Date.now();
  if (!getPolygonApiKey()) {
    logRouteTiming("/api/massive/news", routeStartedAt, { configured: false });
    return NextResponse.json(
      { error: "POLYGON_API_KEY_NOT_CONFIGURED", message: "Set POLYGON_API_KEY to enable news." },
      { status: 503 },
    );
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    logRouteTiming("/api/massive/news", routeStartedAt, { ok: false, code: "INVALID_QUERY" });
    return NextResponse.json({ error: "INVALID_QUERY", details: parsed.error.flatten() }, { status: 400 });
  }

  const tickers = parsed.data.tickers ? parsed.data.tickers.split(",").map((s) => s.trim().toUpperCase()) : [];

  try {
    const news = await fetchNews(tickers, parsed.data.limit);
    logRouteTiming("/api/massive/news", routeStartedAt, { ok: true, tickers: tickers.length, count: news.length });
    return NextResponse.json({ news });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logRouteTiming("/api/massive/news", routeStartedAt, { ok: false, tickers: tickers.length });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
