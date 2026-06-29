import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
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

type ScheduleEventPatch = {
  title?: unknown;
  description?: unknown;
  start_at?: unknown;
  end_at?: unknown;
  color_class?: unknown;
};

function captureScheduleFailure(error: unknown, op: string, eventId: string) {
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: { area: "schedule", op },
    extra: { eventId },
  });
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// PATCH /api/calendar/event/[id]
// Updates an owned local schedule_event. External calendar update parity is
// intentionally out of scope for CAL-1/KEV-29; this route only persists the
// Supabase source of truth and leaves sync work to the follow-up parity issue.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: ScheduleEventPatch;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" && body.description.trim().length
    ? body.description.trim()
    : null;
  const start = parseIso(body.start_at);
  const end = parseIso(body.end_at);
  const color = body.color_class;

  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 422 });
  if (!start || !end) return NextResponse.json({ error: "Start and end times are required" }, { status: 422 });
  if (end <= start) return NextResponse.json({ error: "End time must be after start time" }, { status: 422 });
  if (color !== "a" && color !== "b" && color !== "c") {
    return NextResponse.json({ error: "Invalid event color" }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("schedule_events")
    .update({
      title,
      description,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      color_class: color,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .eq("user_id", user.id)
    .select("id, title, description, start_at, end_at, color_class, all_day")
    .maybeSingle();

  if (error) {
    captureScheduleFailure(error, "update_event", eventId);
    return NextResponse.json({ error: "Could not update event" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  return NextResponse.json({ event: data });
}

// DELETE /api/calendar/event/[id]
// Removes the owned schedule_event locally after best-effort cleanup from any
// connected external calendars. Cleanup failures are surfaced to the caller
// without blocking local deletion, matching the pre-existing client behavior.
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

  const { data: connections, error: connectionsError } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);
  if (connectionsError) {
    captureScheduleFailure(connectionsError, "delete_load_calendar_connections", eventId);
    return NextResponse.json({ error: "Could not load calendar connections" }, { status: 500 });
  }

  const legacyProviders = new Set((connections ?? []).map((c) => c.provider));
  let composioAccounts: Awaited<ReturnType<typeof listComposioCalendarAccounts>> = [];
  if (row.gcal_event_id || row.outlook_event_id) {
    try {
      composioAccounts = await listComposioCalendarAccounts(user.id);
    } catch (error) {
      captureScheduleFailure(error, "delete_load_composio_connections", eventId);
      return NextResponse.json({ error: "Could not load calendar connections" }, { status: 500 });
    }
  }
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
      if (ok) return { ok: true };
      return {
        ok: false,
        error: {
          source,
          transport,
          message: `${source === "google" ? "Google Calendar" : "Outlook"} cleanup failed.`,
        },
      };
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

  let missingCleanupConnection = false;
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
      missingCleanupConnection = true;
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
