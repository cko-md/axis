import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listComposioCalendarAccounts } from "@/lib/calendar/composio";

// Reports calendar connection state. Calendar is Composio-only after the
// direct-adapter removal, so status reflects the user's Composio-connected
// calendars. Mirrors /api/mail/status (which reports via listMailAccounts).
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ google: false, outlook: false });

  let composio;
  try {
    composio = await listComposioCalendarAccounts(user.id);
  } catch (composioError) {
    Sentry.captureException(composioError, {
      tags: { area: "schedule", route: "/api/calendar/status", op: "list_composio_accounts" },
    });
    return NextResponse.json(
      { google: false, outlook: false, error: "Calendar status could not be refreshed.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
  const composioGoogle = composio.find((c) => c.provider === "googlecalendar");
  const composioOutlook = composio.find((c) => c.provider === "outlook");

  return NextResponse.json({
    google: !!composioGoogle,
    googleEmail: composioGoogle?.calendarEmail ?? null,
    outlook: !!composioOutlook,
    outlookEmail: composioOutlook?.calendarEmail ?? null,
  });
}
