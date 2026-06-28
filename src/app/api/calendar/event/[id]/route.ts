import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteGoogleEvent } from "@/lib/calendar/google";
import { deleteOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, deleteComposioEvent } from "@/lib/calendar/composio";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";

type CalendarDeleteError = {
  source: "google" | "outlook";
  transport: "direct" | "composio";
  message: string;
};
type CalendarDeleteResult = { ok: boolean; error?: CalendarDeleteError };

// DELETE /api/calendar/event/[id]
// Removes the schedule_event from all connected external calendars.
// The local Supabase row deletion is handled by the client separately.
// Mirrors sync/route.ts's legacy-preferred-over-Composio precedence so a
// Composio-created event (when no legacy connection exists) is actually
// cleaned up via the Composio path instead of silently no-op'ing.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeStartedAt = Date.now();
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

  async function deleteExternal(
    source: "google" | "outlook",
    transport: "direct" | "composio",
    operation: () => Promise<boolean>,
  ): Promise<CalendarDeleteResult> {
    try {
      const ok = await timedProviderOperation(
        {
          area: "calendar",
          provider: source,
          transport,
          operation: "delete_event",
          timeoutMs: 7_000,
          slowMs: 1_500,
        },
        operation,
      );
      return { ok };
    } catch {
      return {
        ok: false,
        error: {
          source,
          transport,
          message: `${source === "google" ? "Google Calendar" : "Outlook"} cleanup failed.`,
        },
      };
    }
  }

  let googleDeletePromise: Promise<CalendarDeleteResult> = Promise.resolve({ ok: true });
  if (row.gcal_event_id) {
    const gcalEventId = row.gcal_event_id;
    if (legacyProviders.has("google")) {
      googleDeletePromise = deleteExternal("google", "direct", () => deleteGoogleEvent(user.id, gcalEventId));
    } else if (composioGoogle) {
      googleDeletePromise = deleteExternal("google", "composio", () =>
        deleteComposioEvent("googlecalendar", composioGoogle.connectedAccountId, user.id, gcalEventId),
      );
    } else {
      googleDeletePromise = Promise.resolve({
        ok: false,
        error: { source: "google", transport: "composio", message: "No Google Calendar connection found for cleanup." },
      });
    }
  }

  let outlookDeletePromise: Promise<CalendarDeleteResult> = Promise.resolve({ ok: true });
  if (row.outlook_event_id) {
    const outlookEventId = row.outlook_event_id;
    if (legacyProviders.has("outlook")) {
      outlookDeletePromise = deleteExternal("outlook", "direct", () => deleteOutlookEvent(user.id, outlookEventId));
    } else if (composioOutlook) {
      outlookDeletePromise = deleteExternal("outlook", "composio", () =>
        deleteComposioEvent("outlook", composioOutlook.connectedAccountId, user.id, outlookEventId),
      );
    } else {
      outlookDeletePromise = Promise.resolve({
        ok: false,
        error: { source: "outlook", transport: "composio", message: "No Outlook connection found for cleanup." },
      });
    }
  }

  const [googleDelete, outlookDelete] = await Promise.all([googleDeletePromise, outlookDeletePromise]);

  const errors = [
    ...(googleDelete.error ? [googleDelete.error] : []),
    ...(outlookDelete.error ? [outlookDelete.error] : []),
  ];

  logRouteTiming("/api/calendar/event/[id]", routeStartedAt, {
    ok: errors.length === 0,
    partial: errors.length > 0,
  });

  return NextResponse.json({ ok: true, partial: errors.length > 0, errors });
}
