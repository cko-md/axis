import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { deleteUserPasskey } from "@/lib/security/passkeyMutations";
import { rotateMfaTrustEpoch } from "@/lib/auth/securityState";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { readBoundedJson } from "@/lib/http/boundedJson";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DELETE_BODY_BYTES = 4_096;

// ── DELETE — remove a passkey for the current user ───────────────────────────

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const admission = await admit(user.id, ADMISSION_POLICIES.passkeyRegister);
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });
  const parsedBody = await readBoundedJson(req, MAX_DELETE_BODY_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  const body = parsedBody.value as { passkeyId?: unknown } | null;

  const passkeyId = body?.passkeyId;
  if (typeof passkeyId !== "string" || !UUID_RE.test(passkeyId)) {
    return NextResponse.json({ error: "passkeyId is required" }, { status: 400 });
  }

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

  if (await rotateMfaTrustEpoch(supabase, "passkey_delete") === null) return NextResponse.json({ error: "SECURITY_STATE_UNAVAILABLE" }, { status: 503 });
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
