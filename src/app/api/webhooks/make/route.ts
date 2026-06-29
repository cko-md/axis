import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/webhooks/make — inbound receiver for Make scenarios calling
 * back into the app. This is the first inbound-webhook security pattern in
 * the repo (src/lib/integrations/make.ts is outbound-only) — implements the
 * three controls called out in the architecture spec:
 *
 *  1. Shared secret: `x-make-secret` header must match MAKE_WEBHOOK_SECRET.
 *  2. HMAC signature: `x-make-signature` = hex HMAC-SHA256 of the raw body
 *     using MAKE_WEBHOOK_SECRET — proves the body wasn't tampered with.
 *  3. Idempotency: `idempotency_key` in the body is checked against
 *     audit_logs before processing, so a Make retry can't double-apply.
 *
 * Expected body: { event: string, user_id: string, idempotency_key: string, data?: object }
 */
export async function POST(request: NextRequest) {
  const secret = process.env.MAKE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "MAKE_WEBHOOK_SECRET not configured" }, { status: 503 });
  }

  if (request.headers.get("x-make-secret") !== secret) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-make-signature") ?? "";
  const expectedSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const signatureValid =
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!signatureValid) {
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  let body: { event?: string; user_id?: string; idempotency_key?: string; data?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (!body.event || !body.user_id || !body.idempotency_key) {
    return NextResponse.json({ error: "MISSING_FIELDS" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });

  const { data: existing } = await admin
    .from("audit_logs")
    .select("id")
    .eq("user_id", body.user_id)
    .eq("action", `make:${body.event}`)
    .eq("payload->>idempotency_key", body.idempotency_key)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  // Event-specific handling beyond logging is Phase 6 (Workflow design) —
  // this scaffold's job is to make the inbound channel secure and audited.
  await admin.from("audit_logs").insert({
    user_id: body.user_id,
    actor: "make",
    action: `make:${body.event}`,
    payload: { idempotency_key: body.idempotency_key, data: body.data ?? null },
    result: "success",
  });

  return NextResponse.json({ ok: true });
}
