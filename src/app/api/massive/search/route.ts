import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPolygonApiKey, searchTickers } from "@/lib/massive/client";

const querySchema = z.object({
  q: z.string().min(1).max(64),
});

export async function GET(request: NextRequest) {
  if (!getPolygonApiKey()) {
    return NextResponse.json(
      {
        error: "POLYGON_API_KEY_NOT_CONFIGURED",
        message:
          "Set POLYGON_API_KEY or MASSIVE_API_KEY in your environment to enable ticker search.",
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

  try {
    const results = await searchTickers(parsed.data.q);
    return NextResponse.json({ query: parsed.data.q, results });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status =
      e && typeof e === "object" && "status" in e
        ? Number((e as { status: number }).status)
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
