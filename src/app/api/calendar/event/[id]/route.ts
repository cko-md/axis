import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listComposioCalendarAccounts, deleteComposioEvent } from "@/lib/calendar/composio";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";
import { resolveCleanupTransport, validateEventPatch, type ScheduleEventPatchInput } from "@/lib/calendar/event-detail";

type CalendarDeleteError = {
  source: "google" | "outlook";
  transport: "composio";
  message: string;
};
type CalendarDeleteResult = { ok: boolean; error?: CalendarDeleteError };

function captureScheduleFailure(error: unknown, op: string, eventId: string) {
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: { area: "schedule", op },
    extra: { eventId },
  });
}

// PATCH /api/calendar/event/[id]
// Updates an owned local schedule_event. Calendar is Composio-only, and
// Composio has no verified update tool slug (only LIST/CREATE/DELETE were
// confirmed live against Composio's tool catalog — see composio.ts's header
// notes), so a Composio-synced event is left unchanged externally and the
// response reports it as `notSupported` rather than guessing at an unverified
// call. Local persistence always succeeds/fails independently of external sync.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeStartedAt = Date.now();
  const { id: eventId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: ScheduleEventPatchInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const validated = validateEventPatch(body);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: validated.status });
  const { title, description, start_at, end_at, color_class } = validated.patch;

  const { data, error } = await supabase
    .from("schedule_events")
    .update({
      title,
      description,
      start_at,
      end_at,
      color_class,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .eq("user_id", user.id)
    .select("id, title, description, start_at, end_at, color_class, all_day, gcal_event_id, outlook_event_id")
    .maybeSingle();

  if (error) {
    captureScheduleFailure(error, "update_event", eventId);
    return NextResponse.json({ error: "Could not update event" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const { gcal_event_id, outlook_event_id, ...event } = data;

  if (!gcal_event_id && !outlook_event_id) {
    return NextResponse.json({ event, partial: false, errors: [], notSupported: [] });
  }

  // Calendar is Composio-only, and Composio has no verified update tool slug
  // (only LIST/CREATE/DELETE are confirmed live), so an externally-synced event
  // is left unchanged and reported as notSupported rather than guessing at an
  // unverified call — external update is never attempted, so there are no
  // external update errors.
  const notSupported: Array<"google" | "outlook"> = [];
  if (gcal_event_id) notSupported.push("google");
  if (outlook_event_id) notSupported.push("outlook");
  const errors: CalendarDeleteError[] = [];

  for (const err of errors) {
    Sentry.captureException(new Error("Schedule calendar event update sync failed"), {
      tags: { area: "schedule", op: "update_external_event", provider: err.source, transport: err.transport },
      extra: { eventId },
    });
  }

  logRouteTiming("/api/calendar/event/[id]", routeStartedAt, {
    ok: errors.length === 0,
    partial: errors.length > 0 || notSupported.length > 0,
  });

  return NextResponse.json({ event, partial: errors.length > 0, errors, notSupported });
}

// DELETE /api/calendar/event/[id]
// Removes the owned schedule_event locally after best-effort cleanup from any
// connected external calendars. Cleanup failures are surfaced to the caller
// without blocking local deletion, matching the pre-existing client behavior.
// Calendar is Composio-only, so a Composio-created event is cleaned up via the
// Composio path (resolveCleanupTransport); when no Composio connection exists
// the cleanup is flagged as skipped rather than silently no-op'ing.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeStartedAt = Date.now();
  const { id: eventId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Look up external IDs
  const { data: row, error: rowError } = await supabase
    .from("schedule_events")
    .select("gcal_event_id, outlook_event_id")
    .eq("id", eventId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (rowError) {
    captureScheduleFailure(rowError, "delete_lookup_event", eventId);
    return NextResponse.json({ error: "Could not load event" }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  let composioAccounts: Awaited<ReturnType<typeof listComposioCalendarAccounts>> = [];
  if (row.gcal_event_id || row.outlook_event_id) {
    try {
      composioAccounts = await listComposioCalendarAccounts(user.id);
    } catch (error) {
      captureScheduleFailure(error, "delete_load_composio_connections", eventId);
      return NextResponse.json({ error: "Could not load calendar connections" }, { status: 500 });
    }
  }
  const googleTransport = resolveCleanupTransport("google", composioAccounts);
  const outlookTransport = resolveCleanupTransport("outlook", composioAccounts);

  async function deleteExternal(
    source: "google" | "outlook",
    operation: () => Promise<boolean>,
  ): Promise<CalendarDeleteResult> {
    try {
      const ok = await timedProviderOperation(
        {
          area: "calendar",
          provider: source,
          transport: "composio",
          operation: "delete_event",
          timeoutMs: 7_000,
          slowMs: 1_500,
        },
        operation,
      );
      if (ok) return { ok: true };
      return {
        ok: false,
        error: {
          source,
          transport: "composio",
          message: `${source === "google" ? "Google Calendar" : "Outlook"} cleanup failed.`,
        },
      };
    } catch {
      return {
        ok: false,
        error: {
          source,
          transport: "composio",
          message: `${source === "google" ? "Google Calendar" : "Outlook"} cleanup failed.`,
        },
      };
    }
  }

  let missingCleanupConnection = false;
  let googleDeletePromise: Promise<CalendarDeleteResult> = Promise.resolve({ ok: true });
  if (row.gcal_event_id) {
    const gcalEventId = row.gcal_event_id;
    if (googleTransport.transport === "composio") {
      const connectedAccountId = googleTransport.connectedAccountId;
      googleDeletePromise = deleteExternal("google", () =>
        deleteComposioEvent("googlecalendar", connectedAccountId, user.id, gcalEventId),
      );
    } else {
      missingCleanupConnection = true;
    }
  }

  let outlookDeletePromise: Promise<CalendarDeleteResult> = Promise.resolve({ ok: true });
  if (row.outlook_event_id) {
    const outlookEventId = row.outlook_event_id;
    if (outlookTransport.transport === "composio") {
      const connectedAccountId = outlookTransport.connectedAccountId;
      outlookDeletePromise = deleteExternal("outlook", () =>
        deleteComposioEvent("outlook", connectedAccountId, user.id, outlookEventId),
      );
    } else {
      missingCleanupConnection = true;
    }
  }

  const [googleDelete, outlookDelete] = await Promise.all([googleDeletePromise, outlookDeletePromise]);

  const errors = [
    ...(googleDelete.error ? [googleDelete.error] : []),
    ...(outlookDelete.error ? [outlookDelete.error] : []),
  ];

  const { error: deleteError } = await supabase
    .from("schedule_events")
    .delete()
    .eq("id", eventId)
    .eq("user_id", user.id);

  if (deleteError) {
    captureScheduleFailure(deleteError, "delete_event", eventId);
    return NextResponse.json({ error: "Could not delete event" }, { status: 500 });
  }

  for (const error of errors) {
    Sentry.captureException(new Error("Schedule calendar event cleanup failed"), {
      tags: {
        area: "schedule",
        op: "delete_external_event",
        provider: error.source,
        transport: error.transport,
      },
      extra: { eventId },
    });
  }

  const calendarCleanupFailed = missingCleanupConnection || errors.length > 0;
  logRouteTiming("/api/calendar/event/[id]", routeStartedAt, {
    ok: !calendarCleanupFailed,
    partial: calendarCleanupFailed,
  });

  return NextResponse.json({
    ok: true,
    partial: calendarCleanupFailed,
    errors,
    calendarCleanupFailed,
  });
}
