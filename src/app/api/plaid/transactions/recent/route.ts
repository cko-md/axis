import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAccountAdapter } from "@/lib/plaid/adapter";
import type { IntegrationErrorCode } from "@/lib/integrations/types";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Normalized recent transactions via the §10 Plaid adapter — domain
 * Transaction records with provenance (positive = inflow, cent-exact), instead
 * of a Plaid-shaped payload. Read-only; the access token stays server-side.
 * Distinct from POST /api/plaid/transactions (the sync-to-DB path).
 */
const SOFT_CODES: IntegrationErrorCode[] = ["not_supported", "auth_expired"];

const STATUS_FOR_CODE: Partial<Record<IntegrationErrorCode, number>> = {
  not_found: 404,
  rate_limited: 429,
  invalid_request: 400,
  provider_error: 502,
  network: 504,
  unknown: 502,
};

export async function GET(request: NextRequest) {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try { authResult = await supabase.auth.getUser(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error: authError } = authResult;
  if (authError) {
    captureRouteError(new Error("Plaid recent-transactions authentication unavailable"), {
      route: "/api/plaid/transactions/recent", operation: "authenticate", area: "fund",
      provider: "supabase", status: 503, code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const daysParam = Number(request.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 30;

  const result = await resolveAccountAdapter().getTransactions(user.id, { days });

  if (result.ok) {
    return NextResponse.json({ configured: true, connected: true, transactions: result.data });
  }
  if (SOFT_CODES.includes(result.error.code)) {
    return NextResponse.json({
      configured: result.error.code !== "not_supported",
      connected: false,
      transactions: [],
      message: result.error.message,
    });
  }
  const status = result.error.status ?? STATUS_FOR_CODE[result.error.code] ?? 502;
  return NextResponse.json(
    { error: result.error.code, message: result.error.message, retryable: result.error.retryable },
    { status },
  );
}
