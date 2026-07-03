import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listComposioCalendarAccounts } from "@/lib/calendar/composio";

// Reports calendar connection state, merging any legacy direct-OAuth rows with
// Composio-connected calendars — Composio is now the only way to connect a new
// calendar, so the status surfaces those too (otherwise the UI would show
// "Not connected" right after a successful Composio connect). Mirrors the merge
// /api/mail/status does via listMailAccounts.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ google: false, outlook: false });

  const { data, error } = await supabase
    .from("calendar_connections")
    .select("provider, calendar_email")
    .eq("user_id", user.id);
  if (error) {
    Sentry.captureException(error, {
      tags: { area: "schedule", route: "/api/calendar/status", op: "list_direct_accounts" },
    });
    return NextResponse.json(
      { google: false, outlook: false, error: "Calendar status could not be refreshed.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }

  const rows = data ?? [];
  const legacyGoogle = rows.find((r) => r.provider === "google");
  const legacyOutlook = rows.find((r) => r.provider === "outlook");

  let composio;
  try {
    composio = await listComposioCalendarAccounts(user.id);
  } catch (composioError) {
    Sentry.captureException(composioError, {
      tags: { area: "schedule", route: "/api/calendar/status", op: "list_composio_accounts" },
    });
    return NextResponse.json(
      { google: !!legacyGoogle, outlook: !!legacyOutlook, error: "Calendar status could not be fully refreshed.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
  const composioGoogle = composio.find((c) => c.provider === "googlecalendar");
  const composioOutlook = composio.find((c) => c.provider === "outlook");

  return NextResponse.json({
    google: !!legacyGoogle || !!composioGoogle,
    googleEmail: legacyGoogle?.calendar_email ?? composioGoogle?.calendarEmail ?? null,
    outlook: !!legacyOutlook || !!composioOutlook,
    outlookEmail: legacyOutlook?.calendar_email ?? composioOutlook?.calendarEmail ?? null,
  });
}
