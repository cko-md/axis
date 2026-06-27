import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchNews, getPolygonApiKey } from "@/lib/massive/client";

const querySchema = z.object({
  tickers: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export async function GET(request: NextRequest) {
  if (!getPolygonApiKey()) {
    return NextResponse.json(
      { error: "POLYGON_API_KEY_NOT_CONFIGURED", message: "Set POLYGON_API_KEY to enable news." },
      { status: 503 },
    );
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_QUERY", details: parsed.error.flatten() }, { status: 400 });
  }

  const tickers = parsed.data.tickers ? parsed.data.tickers.split(",").map((s) => s.trim().toUpperCase()) : [];

  try {
    const news = await fetchNews(tickers, parsed.data.limit);
    return NextResponse.json({ news });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
