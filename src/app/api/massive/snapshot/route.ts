import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { logRouteTiming } from "@/lib/observability/providerTiming";

const querySchema = z.object({
  symbol: z.string().min(1).max(12),
});

export async function GET(request: NextRequest) {
  const routeStartedAt = Date.now();
  if (!getPolygonApiKey()) {
    logRouteTiming("/api/massive/snapshot", routeStartedAt, { configured: false });
    return NextResponse.json(
      {
        error: "POLYGON_API_KEY_NOT_CONFIGURED",
        message:
          "Set POLYGON_API_KEY or MASSIVE_API_KEY in your environment to enable live snapshots.",
      },
      { status: 503 },
    );
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    logRouteTiming("/api/massive/snapshot", routeStartedAt, { ok: false, code: "INVALID_QUERY" });
    return NextResponse.json(
      { error: "INVALID_QUERY", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const snapshot = await fetchSnapshot(parsed.data.symbol.toUpperCase());
    logRouteTiming("/api/massive/snapshot", routeStartedAt, { ok: true, symbol: parsed.data.symbol.toUpperCase() });
    return NextResponse.json({
      symbol: parsed.data.symbol.toUpperCase(),
      ...snapshot,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      e && typeof e === "object" && "status" in e
        ? Number((e as { status: number }).status)
        : 502;
    logRouteTiming("/api/massive/snapshot", routeStartedAt, { ok: false, symbol: parsed.data.symbol.toUpperCase(), status });
    return NextResponse.json({ error: message }, { status });
  }
}
