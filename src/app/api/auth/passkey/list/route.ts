import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const ROUTE = "auth.passkey.list";

// ── GET — list passkeys for the current user ──────────────────────────────────

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "PASSKEY_SERVICE_NOT_CONFIGURED",
        message: "Passkey settings are temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  const { data, error } = await admin
    .from("user_passkeys")
    .select("id, name, device_type, backed_up, created_at, last_used_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "list_credentials",
      area: "auth",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEYS_UNAVAILABLE" }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
