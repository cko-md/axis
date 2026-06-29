import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteGoogleEvent } from "@/lib/calendar/google";
import { deleteOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, deleteComposioEvent } from "@/lib/calendar/composio";

// DELETE /api/calendar/event/[id]
// Removes the schedule_event from all connected external calendars.
// The local Supabase row deletion is handled by the client separately.
// Mirrors sync/route.ts's legacy-preferred-over-Composio precedence so a
// Composio-created event (when no legacy connection exists) is actually
// cleaned up via the Composio path instead of silently no-op'ing.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Look up external IDs
  const { data: row } = await supabase
    .from("schedule_events")
    .select("gcal_event_id, outlook_event_id")
    .eq("id", eventId)
    .eq("user_id", user.id)
    .single();

  if (!row) return NextResponse.json({ ok: true }); // already gone

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);
  const legacyProviders = new Set((connections ?? []).map((c) => c.provider));
  const composioAccounts = row.gcal_event_id || row.outlook_event_id ? await listComposioCalendarAccounts(user.id) : [];
  const composioGoogle = !legacyProviders.has("google") && composioAccounts.find((a) => a.provider === "googlecalendar");
  const composioOutlook = !legacyProviders.has("outlook") && composioAccounts.find((a) => a.provider === "outlook");

  await Promise.all([
    !row.gcal_event_id
      ? Promise.resolve()
      : legacyProviders.has("google")
        ? deleteGoogleEvent(user.id, row.gcal_event_id).catch(() => false)
        : composioGoogle
          ? deleteComposioEvent("googlecalendar", composioGoogle.connectedAccountId, user.id, row.gcal_event_id).catch(() => false)
          : Promise.resolve(false),
    !row.outlook_event_id
      ? Promise.resolve()
      : legacyProviders.has("outlook")
        ? deleteOutlookEvent(user.id, row.outlook_event_id).catch(() => false)
        : composioOutlook
          ? deleteComposioEvent("outlook", composioOutlook.connectedAccountId, user.id, row.outlook_event_id).catch(() => false)
          : Promise.resolve(false),
  ]);

  return NextResponse.json({ ok: true });
}
