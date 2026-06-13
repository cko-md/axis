import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchPrevQuote,
  fetchSnapshot,
  getPolygonApiKey,
} from "@/lib/massive/client";

const querySchema = z.object({
  symbol: z.string().min(1).max(12),
  snapshot: z.enum(["true", "false"]).optional(),
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

  const { symbol, snapshot } = parsed.data;

  try {
    const quote =
      snapshot === "true"
        ? await fetchSnapshot(symbol.toUpperCase())
        : await fetchPrevQuote(symbol.toUpperCase());
    return NextResponse.json({ symbol: symbol.toUpperCase(), ...quote });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      e && typeof e === "object" && "status" in e
        ? Number((e as { status: number }).status)
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
