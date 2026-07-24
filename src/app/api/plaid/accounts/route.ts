import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAccountAdapter } from "@/lib/plaid/adapter";
import type { IntegrationErrorCode } from "@/lib/integrations/types";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Normalized account balances via the §10 account adapter — returns domain
 * Account records with provenance + freshness (feeds the FreshnessBadge),
 * instead of a Plaid-shaped payload. Auth required; the access token stays
 * server-side.
 *
 * "not_supported" (unconfigured) and "auth_expired" (no linked item) return 200
 * with a `configured`/`connected` flag so the Cash panel can render a calm
 * connect-a-bank state rather than treating it as an error.
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

export async function GET() {
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
    captureRouteError(new Error("Plaid accounts authentication unavailable"), {
      route: "/api/plaid/accounts", operation: "authenticate", area: "fund",
      provider: "supabase", status: 503, code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adapter = resolveAccountAdapter();
  const result = await adapter.getAccounts(user.id);

  if (result.ok) {
    return NextResponse.json({ configured: true, connected: true, accounts: result.data });
  }

  if (SOFT_CODES.includes(result.error.code)) {
    return NextResponse.json({
      configured: result.error.code !== "not_supported",
      connected: false,
      accounts: [],
      message: result.error.message,
    });
  }

  const status = result.error.status ?? STATUS_FOR_CODE[result.error.code] ?? 502;
  return NextResponse.json(
    { error: result.error.code, message: result.error.message, retryable: result.error.retryable },
    { status },
  );
}
