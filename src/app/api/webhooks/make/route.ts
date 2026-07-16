import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { optionalEnv } from "@/lib/env";
import { timingSafeStringEqual, verifyHmacSha256Hex } from "@/lib/security/webhookSignature";
import * as Sentry from "@sentry/nextjs";

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
  const secret = optionalEnv("MAKE_WEBHOOK_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "MAKE_WEBHOOK_SECRET not configured" }, { status: 503 });
  }

  if (!timingSafeStringEqual(request.headers.get("x-make-secret"), secret)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const rawBody = await request.text();
  if (!verifyHmacSha256Hex({ secret, rawBody, signature: request.headers.get("x-make-signature") })) {
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  let body: { event?: string; user_id?: string; idempotency_key?: string; data?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.event !== "string" || typeof body.user_id !== "string" ||
    typeof body.idempotency_key !== "string" ||
    !body.event || !body.user_id || !body.idempotency_key ||
    !/^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(body.event) ||
    !/^[0-9a-f-]{36}$/i.test(body.user_id) ||
    body.idempotency_key.length > 200
  ) {
    return NextResponse.json({ error: "MISSING_FIELDS" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });

  const { data: existing, error: lookupError } = await admin
    .from("audit_logs")
    .select("id")
    .eq("user_id", body.user_id)
    .eq("action", `make:${body.event}`)
    .eq("payload->>idempotency_key", body.idempotency_key)
    .maybeSingle();
  if (lookupError) {
    Sentry.captureException(lookupError, {
      tags: { area: "integrations", provider: "make", operation: "webhook_dedupe_lookup" },
    });
    return NextResponse.json({ error: "WEBHOOK_PERSISTENCE_UNAVAILABLE" }, { status: 503 });
  }

  if (existing) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  // Event-specific handling beyond logging is Phase 6 (Workflow design) —
  // this scaffold's job is to make the inbound channel secure and audited.
  const { error: insertError } = await admin.from("audit_logs").insert({
    user_id: body.user_id,
    actor: "make",
    action: `make:${body.event}`,
    payload: { idempotency_key: body.idempotency_key, data: body.data ?? null },
    result: "success",
  });
  if (insertError) {
    Sentry.captureException(insertError, {
      tags: { area: "integrations", provider: "make", operation: "webhook_audit_insert" },
    });
    return NextResponse.json({ error: "WEBHOOK_PERSISTENCE_UNAVAILABLE" }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
