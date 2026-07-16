import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { deleteUserPasskey } from "@/lib/security/passkeyMutations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── DELETE — remove a passkey for the current user ───────────────────────────

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Passkey deletion service role unavailable"), {
      route: "passkey_delete",
      operation: "delete_passkey",
      area: "auth",
      status: 503,
      code: "PASSKEY_SERVICE_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SERVICE_UNAVAILABLE" }, { status: 503 });
  }

  let body: { passkeyId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { passkeyId } = body;
  if (typeof passkeyId !== "string" || !UUID_RE.test(passkeyId)) {
    return NextResponse.json({ error: "passkeyId is required" }, { status: 400 });
  }

  const deleted = await deleteUserPasskey({
    userId: user.id,
    passkeyId,
  }, admin);
  if (!deleted.ok) {
    if (deleted.code === "NOT_FOUND") {
      return NextResponse.json({ error: "PASSKEY_NOT_FOUND" }, { status: 404 });
    }
    const status = deleted.code === "SERVICE_UNAVAILABLE" ? 503 : 500;
    captureRouteError(new Error("Atomic passkey deletion failed"), {
      route: "passkey_delete",
      operation: "delete_passkey",
      area: "auth",
      status,
      code: "PASSKEY_DELETE_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_DELETE_FAILED" }, { status });
  }

  return NextResponse.json({ ok: true, hasPasskeys: deleted.hasPasskeys });
}
