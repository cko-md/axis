import { captureRouteError } from "@/lib/observability/captureRouteError";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type SecurityStateClient = SupabaseClient<Database>;

export async function readMfaTrustEpoch(client: SecurityStateClient, userId: string): Promise<number | null> {
  try {
    const { data, error } = await client
      .from("user_security_state")
      .select("mfa_trust_epoch")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data || !Number.isSafeInteger(data.mfa_trust_epoch) || data.mfa_trust_epoch < 1) {
      captureRouteError(new Error("Security trust epoch read unavailable"), {
        route: "auth/security-state",
        operation: "read_mfa_trust_epoch",
        area: "auth",
        status: 503,
        code: "SECURITY_STATE_UNAVAILABLE",
      });
      return null;
    }
    return data.mfa_trust_epoch;
  } catch {
    captureRouteError(new Error("Security trust epoch read unavailable"), {
      route: "auth/security-state",
      operation: "read_mfa_trust_epoch",
      area: "auth",
      status: 503,
      code: "SECURITY_STATE_UNAVAILABLE",
    });
    return null;
  }
}

/** Rotate all remembered-device grants after a material account-security event. */
export async function rotateMfaTrustEpoch(client: SecurityStateClient, route: string): Promise<number | null> {
  try {
    const { data, error } = await client.rpc("rotate_own_mfa_trust_epoch");
    if (!error && Number.isSafeInteger(data) && (data ?? 0) >= 1) return data;
  } catch {
    // Normalize an unavailable database/client to the same fail-closed result.
  }
  {
    captureRouteError(new Error("Security trust epoch rotation unavailable"), {
      route,
      operation: "rotate_mfa_trust_epoch",
      area: "auth",
      status: 503,
      code: "SECURITY_STATE_UNAVAILABLE",
    });
  }
  return null;
}
