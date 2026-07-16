import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const ROUTE = "auth.passkey.delete";

// ── DELETE — remove a passkey for the current user ───────────────────────────

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { passkeyId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { passkeyId } = body;
  if (!passkeyId || typeof passkeyId !== "string") {
    return NextResponse.json({ error: "passkeyId is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "PASSKEY_SERVICE_NOT_CONFIGURED",
        message: "Passkey changes are temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  // Delete the specified passkey through the trusted boundary, owner-scoped.
  const { data: deleted, error: deleteError } = await admin
    .from("user_passkeys")
    .delete()
    .eq("id", passkeyId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (deleteError) {
    captureRouteError(deleteError, {
      route: ROUTE,
      operation: "delete_credential",
      area: "auth",
      status: 500,
      code: "PASSKEY_DELETE_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_DELETE_FAILED" }, { status: 500 });
  }
  if (!deleted) {
    return NextResponse.json({ error: "PASSKEY_NOT_FOUND" }, { status: 404 });
  }

  // Check if any passkeys remain; if not, mark passkey_enabled=false
  const { count, error: countError } = await admin
    .from("user_passkeys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (countError) {
    captureRouteError(countError, {
      route: ROUTE,
      operation: "count_credentials",
      area: "auth",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json(
      { ok: true, warning: "PASSKEY_SETTINGS_UPDATE_FAILED" },
      { status: 200 },
    );
  }

  if (count === 0) {
    const { error: settingsError } = await admin.from("user_auth_settings").upsert(
      {
        user_id: user.id,
        passkey_enabled: false,
      },
      { onConflict: "user_id" },
    );
    if (settingsError) {
      captureRouteError(settingsError, {
        route: ROUTE,
        operation: "update_settings",
        area: "auth",
        status: 500,
        code: "PASSKEY_SETTINGS_UPDATE_FAILED",
      });
      return NextResponse.json(
        { ok: true, warning: "PASSKEY_SETTINGS_UPDATE_FAILED" },
        { status: 200 },
      );
    }
  }

  return NextResponse.json({ ok: true });
}
