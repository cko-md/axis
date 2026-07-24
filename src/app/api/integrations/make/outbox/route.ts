import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import {
  toMakeOutboxPublicItem,
  type MakeOutboxMetadataRow,
} from "@/lib/integrations/makeOutbox";
import { createClient } from "@/lib/supabase/server";

const METADATA_SELECT =
  "id, provider, event_type, status, attempt_count, last_error_code, last_http_status, locked_at, accepted_at, delivered_at, created_at, updated_at";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("integration_delivery_outbox")
    .select(METADATA_SELECT)
    .in("status", ["pending", "accepted", "failed", "dead_letter"])
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    Sentry.captureException(new Error("Make outbox metadata query failed"), {
      tags: { area: "integrations", provider: "make", operation: "outbox_list" },
      extra: { code: error.code },
    });
    return NextResponse.json({ error: "OUTBOX_UNAVAILABLE" }, { status: 500 });
  }

  return NextResponse.json({
    deliveries: (data as unknown as MakeOutboxMetadataRow[]).map((row) =>
      toMakeOutboxPublicItem(row),
    ),
  });
}
