import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { deleteGoogleEvent } from "@/lib/calendar/google";
import { deleteOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, deleteComposioEvent } from "@/lib/calendar/composio";

type ScheduleEventPatch = {
  title?: unknown;
  description?: unknown;
  start_at?: unknown;
  end_at?: unknown;
  color_class?: unknown;
};

type CleanupTask = {
  provider: "google" | "outlook";
  transport: "direct" | "composio";
  run: () => Promise<boolean>;
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

  const cleanupTasks: CleanupTask[] = [];
  let missingCleanupConnection = false;
  if (row.gcal_event_id) {
    if (legacyProviders.has("google")) {
      cleanupTasks.push({ provider: "google", transport: "direct", run: () => deleteGoogleEvent(user.id, row.gcal_event_id) });
    } else if (composioGoogle) {
      cleanupTasks.push({
        provider: "google",
        transport: "composio",
        run: () => deleteComposioEvent("googlecalendar", composioGoogle.connectedAccountId, user.id, row.gcal_event_id),
      });
    } else {
      missingCleanupConnection = true;
    }
  }
  if (row.outlook_event_id) {
    if (legacyProviders.has("outlook")) {
      cleanupTasks.push({ provider: "outlook", transport: "direct", run: () => deleteOutlookEvent(user.id, row.outlook_event_id) });
    } else if (composioOutlook) {
      cleanupTasks.push({
        provider: "outlook",
        transport: "composio",
        run: () => deleteComposioEvent("outlook", composioOutlook.connectedAccountId, user.id, row.outlook_event_id),
      });
    } else {
      missingCleanupConnection = true;
    }
  }

  const cleanupResults = await Promise.all(
    cleanupTasks.map(async (task) => {
      try {
        return { provider: task.provider, transport: task.transport, ok: await task.run() };
      } catch {
        return { provider: task.provider, transport: task.transport, ok: false };
      }
    }),
  );
  for (const result of cleanupResults.filter((r) => !r.ok)) {
    Sentry.captureException(new Error("Schedule calendar event cleanup failed"), {
      tags: { area: "schedule", op: "delete_external_event", provider: result.provider, transport: result.transport },
      extra: { eventId },
    });
  }

  const { error: deleteError } = await supabase
    .from("schedule_events")
    .delete()
    .eq("id", eventId)
    .eq("user_id", user.id);

  if (deleteError) {
    captureScheduleFailure(deleteError, "delete_event", eventId);
    return NextResponse.json({ error: "Could not delete event" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    calendarCleanupFailed: missingCleanupConnection || cleanupResults.some((r) => !r.ok),
  });
}
