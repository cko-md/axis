import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchAggs, getPolygonApiKey } from "@/lib/massive/client";

const querySchema = z.object({
  symbol: z.string().min(1).max(12),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: NextRequest) {
  if (!getPolygonApiKey()) {
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
    return NextResponse.json(
      { error: "INVALID_QUERY", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { symbol, from, to } = parsed.data;

  try {
    const bars = await fetchAggs(symbol.toUpperCase(), from, to);
    return NextResponse.json({ symbol: symbol.toUpperCase(), from, to, bars });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      e && typeof e === "object" && "status" in e
        ? Number((e as { status: number }).status)
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
