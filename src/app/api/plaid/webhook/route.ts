import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { verifyPlaidWebhook } from "../_lib";
import { syncPlaidTransactions } from "@/lib/fund/syncPlaidTransactions";

/**
 * POST /api/plaid/webhook — Plaid's inbound notification that new
 * transactions are ready for an item. This is the primary event-driven
 * sync trigger; /api/cron/finance-daily is the nightly safety net for
 * anything this misses. Never trusts an unsigned payload — see
 * verifyPlaidWebhook in ../_lib.ts.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const jwt = request.headers.get("plaid-verification");
  if (!jwt) return NextResponse.json({ error: "MISSING_VERIFICATION" }, { status: 401 });

  const payload = await verifyPlaidWebhook(jwt, rawBody);
  if (!payload) return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });

  let body: { webhook_type?: string; item_id?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  if (body.webhook_type !== "TRANSACTIONS" || !body.item_id) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: true, skipped: true }); // no SUPABASE_SERVICE_ROLE_KEY configured

  const { data: connection, error: connectionError } = await admin
    .from("fund_connections")
    .select("id, user_id, access_token_enc")
    .eq("provider", "plaid")
    .eq("item_id", body.item_id)
    .eq("status", "linked")
    .eq("authority", "provider_verified")
    .not("verified_at", "is", null)
    .maybeSingle();
  if (connectionError) {
    Sentry.captureException(connectionError, {
      tags: { area: "fund", provider: "plaid", operation: "load_webhook_connection" },
    });
    return NextResponse.json({ error: "CONNECTION_LOOKUP_FAILED" }, { status: 502 });
  }

  if (!connection?.access_token_enc) return NextResponse.json({ ok: true, skipped: true });
  const accessToken = decrypt(connection.access_token_enc);
  if (!accessToken) return NextResponse.json({ ok: true, skipped: true });

  const result = await syncPlaidTransactions(admin, connection.user_id, connection.id, accessToken);
  if ("error" in result) {
    Sentry.captureMessage("Plaid webhook sync failed", {
      level: "error",
      tags: { area: "fund", provider: "plaid", operation: "webhook_sync", error_code: result.error },
    });
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, synced: result.synced });
}
