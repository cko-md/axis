import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { readBoundedPlaidBody, verifyPlaidWebhook } from "../_lib";
import { syncPlaidTransactions } from "@/lib/fund/syncPlaidTransactions";

/**
 * POST /api/plaid/webhook — Plaid's inbound notification that new
 * transactions are ready for an item. This is the primary event-driven
 * sync trigger; /api/cron/finance-daily is the nightly safety net for
 * anything this misses. Never trusts an unsigned payload — see
 * verifyPlaidWebhook in ../_lib.ts.
 */
export async function POST(request: NextRequest) {
  const jwt = request.headers.get("plaid-verification");
  if (!jwt) return NextResponse.json({ error: "MISSING_VERIFICATION" }, { status: 401 });
  const rawBody = await readBoundedPlaidBody(request, 65_536);
  if (rawBody === null) {
    return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
  }
  const payload = await verifyPlaidWebhook(jwt, rawBody);
  if (!payload) return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });

  let parsedBody: unknown;
  let body: {
    webhook_type?: unknown;
    webhook_code?: unknown;
    item_id?: unknown;
    error?: unknown;
  };
  try {
    parsedBody = JSON.parse(rawBody);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
    }
    body = parsedBody as typeof body;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  if (
    typeof body.webhook_type !== "string"
    || body.webhook_type.length > 64
    || typeof body.webhook_code !== "string"
    || body.webhook_code.length > 64
    || typeof body.item_id !== "string"
    || !/^[A-Za-z0-9_-]{1,256}$/.test(body.item_id)
  ) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) {
    Sentry.captureMessage("Plaid webhook admin client unavailable", {
      level: "error",
      tags: { area: "fund", provider: "supabase", operation: "load_webhook_connection" },
    });
    return NextResponse.json({ error: "WEBHOOK_PROCESSING_UNAVAILABLE" }, { status: 503 });
  }

  const { data: connection, error: connectionError } = await admin
    .from("fund_connections")
    .select("id, user_id, status, authority, verified_at, access_token_enc, provider_event_at")
    .eq("provider", "plaid")
    .eq("item_id", body.item_id)
    .neq("status", "revoked")
    .maybeSingle();
  if (connectionError) {
    Sentry.captureMessage("Plaid webhook connection lookup failed", {
      level: "error",
      tags: { area: "fund", provider: "supabase", operation: "load_webhook_connection" },
    });
    return NextResponse.json({ error: "CONNECTION_LOOKUP_FAILED" }, { status: 502 });
  }

  if (!connection) return NextResponse.json({ ok: true, skipped: true });

  if (body.webhook_type === "ITEM") {
    const eventAt = new Date((payload.iat as number) * 1_000).toISOString();
    let update: Record<string, unknown> | null = null;
    if (body.webhook_code === "USER_PERMISSION_REVOKED") {
      update = {
        status: "revoked",
        authority: "legacy_unknown",
        verified_at: null,
        action_required: null,
        access_token_enc: null,
        refresh_token_enc: null,
        provider_event_at: eventAt,
        updated_at: new Date().toISOString(),
      };
    } else if (body.webhook_code === "ERROR") {
      const errorCode = body.error && typeof body.error === "object" && !Array.isArray(body.error)
        ? (body.error as Record<string, unknown>).error_code
        : null;
      update = {
        status: "error",
        action_required: errorCode === "ITEM_LOGIN_REQUIRED" ? "login_required" : "provider_error",
        provider_event_at: eventAt,
        updated_at: new Date().toISOString(),
      };
    } else if (
      body.webhook_code === "PENDING_DISCONNECT"
      || body.webhook_code === "PENDING_EXPIRATION"
    ) {
      update = {
        action_required: body.webhook_code === "PENDING_DISCONNECT"
          ? "pending_disconnect"
          : "pending_expiration",
        provider_event_at: eventAt,
        updated_at: new Date().toISOString(),
      };
    } else {
      return NextResponse.json({ ok: true, skipped: true });
    }
    const { data: updated, error: updateError } = await admin
      .from("fund_connections")
      .update(update)
      .eq("id", connection.id)
      .eq("user_id", connection.user_id)
      .eq("provider", "plaid")
      .or(`provider_event_at.is.null,provider_event_at.lte.${eventAt}`)
      .select("id")
      .maybeSingle();
    if (updateError) {
      Sentry.captureMessage("Plaid Item webhook state transition failed", {
        level: "error",
        tags: { area: "fund", provider: "supabase", operation: "apply_item_webhook" },
      });
      return NextResponse.json({ error: "WEBHOOK_PROCESSING_UNAVAILABLE" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, stale: !updated });
  }

  if (body.webhook_type !== "TRANSACTIONS") {
    return NextResponse.json({ ok: true, skipped: true });
  }
  if (
    connection.status !== "linked"
    || connection.authority !== "provider_verified"
    || typeof connection.verified_at !== "string"
  ) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  if (!connection.access_token_enc) {
    Sentry.captureMessage("Plaid webhook connection credential unavailable", {
      level: "error",
      tags: { area: "fund", provider: "plaid", operation: "decrypt_webhook_token" },
    });
    return NextResponse.json({ error: "WEBHOOK_PROCESSING_UNAVAILABLE" }, { status: 503 });
  }
  let accessToken: string | null;
  try {
    accessToken = decrypt(connection.access_token_enc);
  } catch {
    Sentry.captureMessage("Plaid webhook connection credential decryption failed", {
      level: "error",
      tags: { area: "fund", provider: "plaid", operation: "decrypt_webhook_token" },
    });
    return NextResponse.json({ error: "WEBHOOK_PROCESSING_UNAVAILABLE" }, { status: 503 });
  }
  if (!accessToken) {
    Sentry.captureMessage("Plaid webhook connection credential decryption failed", {
      level: "error",
      tags: { area: "fund", provider: "plaid", operation: "decrypt_webhook_token" },
    });
    return NextResponse.json({ error: "WEBHOOK_PROCESSING_UNAVAILABLE" }, { status: 503 });
  }

  let result: Awaited<ReturnType<typeof syncPlaidTransactions>>;
  try {
    result = await syncPlaidTransactions(
      admin,
      connection.user_id,
      connection.id,
      accessToken,
      AbortSignal.timeout(20_000),
    );
  } catch {
    Sentry.captureMessage("Plaid webhook sync failed unexpectedly", {
      level: "error",
      tags: { area: "fund", provider: "plaid", operation: "webhook_sync" },
    });
    return NextResponse.json({ ok: false, error: "WEBHOOK_SYNC_UNAVAILABLE" }, { status: 503 });
  }
  if ("error" in result) {
    Sentry.captureMessage("Plaid webhook sync failed", {
      level: "error",
      tags: { area: "fund", provider: "plaid", operation: "webhook_sync", error_code: result.error },
    });
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, synced: result.synced });
}
