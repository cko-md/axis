import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createGoogleEvent } from "@/lib/calendar/google";
import { createOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, createComposioEvent } from "@/lib/calendar/composio";

// POST /api/calendar/sync
// Creates the given schedule_event in all connected calendars and
// writes the external IDs back to the schedule_events row. Legacy
// direct-OAuth calendars are preferred over Composio-connected ones for
// the same provider, to avoid creating the event twice in the same calendar.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { eventId?: unknown; title?: unknown; start_at?: unknown; end_at?: unknown; description?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { eventId, title, start_at, end_at, description } = body;
  if (typeof eventId !== "string" || typeof title !== "string" || typeof start_at !== "string" || typeof end_at !== "string") {
    return NextResponse.json({ error: "eventId, title, start_at, end_at are required" }, { status: 400 });
  }

  const event = { title, start_at, end_at, description: typeof description === "string" ? description : undefined };

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);
  const legacyProviders = new Set((connections ?? []).map((c) => c.provider));
  const composioAccounts = await listComposioCalendarAccounts(user.id);
  const composioGoogle = !legacyProviders.has("google") && composioAccounts.find((a) => a.provider === "googlecalendar");
  const composioOutlook = !legacyProviders.has("outlook") && composioAccounts.find((a) => a.provider === "outlook");

  const [gcalId, outlookId] = await Promise.all([
    legacyProviders.has("google")
      ? createGoogleEvent(user.id, event).catch(() => null)
      : composioGoogle
        ? createComposioEvent("googlecalendar", composioGoogle.connectedAccountId, user.id, event).catch(() => null)
        : Promise.resolve(null),
    legacyProviders.has("outlook")
      ? createOutlookEvent(user.id, event).catch(() => null)
      : composioOutlook
        ? createComposioEvent("outlook", composioOutlook.connectedAccountId, user.id, event).catch(() => null)
        : Promise.resolve(null),
  ]);

  // Write IDs back — only update columns where sync succeeded
  const patch: Record<string, string> = {};
  if (gcalId) patch.gcal_event_id = gcalId;
  if (outlookId) patch.outlook_event_id = outlookId;

  if (Object.keys(patch).length) {
    await supabase.from("schedule_events").update(patch).eq("id", eventId).eq("user_id", user.id);
  }

  return NextResponse.json({ gcalId, outlookId });
}
