import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveMarketDataAdapter } from "@/lib/markets/adapter";
import type { IntegrationErrorCode } from "@/lib/integrations/types";

/**
 * Normalized market quote via the §10 market-data adapter — returns a domain
 * MarketQuote with provenance + freshness (feeds the FreshnessBadge), instead of
 * a provider-shaped payload. Read-only public market data (matches the existing
 * /api/massive/* convention).
 */
const querySchema = z.object({
  symbol: z.string().min(1).max(12),
  snapshot: z.enum(["true", "false"]).optional(),
});

const STATUS_FOR_CODE: Partial<Record<IntegrationErrorCode, number>> = {
  not_supported: 503,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  auth_expired: 502,
  provider_error: 502,
  network: 504,
  unknown: 502,
};

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_QUERY", details: parsed.error.flatten() }, { status: 400 });
  }

  const adapter = resolveMarketDataAdapter();
  const result = await adapter.getQuote(parsed.data.symbol, { snapshot: parsed.data.snapshot === "true" });

  if (!result.ok) {
    const status = result.error.status ?? STATUS_FOR_CODE[result.error.code] ?? 502;
    return NextResponse.json(
      { error: result.error.code, message: result.error.message, retryable: result.error.retryable },
      { status },
    );
  }
  return NextResponse.json({ quote: result.data });
}
