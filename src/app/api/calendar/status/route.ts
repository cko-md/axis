import { NextResponse } from "next/server";
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

  const { data } = await supabase
    .from("calendar_connections")
    .select("provider, calendar_email")
    .eq("user_id", user.id);

  const rows = data ?? [];
  const legacyGoogle = rows.find((r) => r.provider === "google");
  const legacyOutlook = rows.find((r) => r.provider === "outlook");

  const composio = await listComposioCalendarAccounts(user.id);
  const composioGoogle = composio.find((c) => c.provider === "googlecalendar");
  const composioOutlook = composio.find((c) => c.provider === "outlook");

  return NextResponse.json({
    google: !!legacyGoogle || !!composioGoogle,
    googleEmail: legacyGoogle?.calendar_email ?? composioGoogle?.calendarEmail ?? null,
    outlook: !!legacyOutlook || !!composioOutlook,
    outlookEmail: legacyOutlook?.calendar_email ?? composioOutlook?.calendarEmail ?? null,
  });
}
