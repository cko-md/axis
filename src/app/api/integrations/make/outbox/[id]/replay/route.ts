import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { replayMakeNotification, type NotifyFailureReason } from "@/lib/fund/notifyViaMake";
import {
  createSupabaseMakeOutboxStore,
  toMakeOutboxPublicItem,
} from "@/lib/integrations/makeOutbox";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function responseStatus(reason: NotifyFailureReason): number {
  if (reason === "NOT_REPLAYABLE" || reason === "OUTBOX_CLAIM_FAILED") return 409;
  if (reason === "WEBHOOK_NOT_CONFIGURED" || reason === "OUTBOX_ENCRYPTION_UNAVAILABLE") {
    return 503;
  }
  if (reason === "DELIVERY_FAILED") return 502;
  return 500;
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await createClient();
  const {
    data: { user },
    error: authError,
  } = await session.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { success } =
    (await redisRateLimit(user.id, 10, "10 m", "axis:make-outbox-replay")) ??
    memoryRateLimit(`make-outbox-replay:${user.id}`, 10, 10 * 60_000);
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  const admin = createAdminClient();
  if (!admin) {
    Sentry.captureException(new Error("Make outbox replay service role unavailable"), {
      tags: { area: "integrations", provider: "make", operation: "outbox_replay" },
    });
    return NextResponse.json({ error: "OUTBOX_UNAVAILABLE" }, { status: 503 });
  }

  const store = createSupabaseMakeOutboxStore(admin);
  const owned = await store.getOwned(id, user.id);
  if (!owned.ok) {
    Sentry.captureException(new Error("Make outbox owner lookup failed"), {
      tags: { area: "integrations", provider: "make", operation: "outbox_owner_lookup" },
    });
    return NextResponse.json({ error: "OUTBOX_UNAVAILABLE" }, { status: 500 });
  }
  if (!owned.data) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const result = await replayMakeNotification(admin, owned.data, { store });
  const refreshed = await store.getOwned(id, user.id);
  const delivery = refreshed.ok && refreshed.data
    ? toMakeOutboxPublicItem(refreshed.data)
    : toMakeOutboxPublicItem(owned.data);

  if (!result.sent) {
    return NextResponse.json(
      { error: result.reason, retryable: result.retryable, delivery },
      { status: responseStatus(result.reason) },
    );
  }

  return NextResponse.json({ delivered: true, deduped: result.deduped, delivery });
}
