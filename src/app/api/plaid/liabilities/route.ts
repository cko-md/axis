import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAccountAdapter } from "@/lib/plaid/adapter";
import type { IntegrationErrorCode } from "@/lib/integrations/types";

/**
 * Normalized liabilities (credit/student/mortgage) via the §10 Plaid adapter —
 * domain Liability records with provenance + freshness, joined to their account
 * balances. Read-only; the access token stays server-side.
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
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await resolveAccountAdapter().getLiabilities(user.id);

  if (result.ok) {
    return NextResponse.json({ configured: true, connected: true, liabilities: result.data });
  }
  if (SOFT_CODES.includes(result.error.code)) {
    return NextResponse.json({
      configured: result.error.code !== "not_supported",
      connected: false,
      liabilities: [],
      message: result.error.message,
    });
  }
  const status = result.error.status ?? STATUS_FOR_CODE[result.error.code] ?? 502;
  return NextResponse.json(
    { error: result.error.code, message: result.error.message, retryable: result.error.retryable },
    { status },
  );
}
