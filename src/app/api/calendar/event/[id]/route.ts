import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { deleteGoogleEvent, updateGoogleEvent } from "@/lib/calendar/google";
import { deleteOutlookEvent, updateOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, deleteComposioEvent } from "@/lib/calendar/composio";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";
import { resolveCleanupTransport, validateEventPatch, type ScheduleEventPatchInput } from "@/lib/calendar/event-detail";
import { listHealthyLegacyProviders } from "@/lib/calendar/legacy-providers";

type CalendarDeleteError = {
  source: "google" | "outlook";
  transport: "direct" | "composio";
  message: string;
};
type CalendarDeleteResult = { ok: boolean; error?: CalendarDeleteError };

type CalendarSyncOutcome = { ok: boolean; error?: CalendarDeleteError };

function captureScheduleFailure(error: unknown, op: string, eventId: string) {
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: { area: "schedule", op },
    extra: { eventId },
  });
}

// PATCH /api/calendar/event/[id]
// Updates an owned local schedule_event, then best-effort propagates the
// change to any connected external calendar the event was previously synced
// to (CAL-2). Direct-OAuth Google/Outlook support update natively. Composio
// has no verified update tool slug (only LIST/CREATE/DELETE were confirmed
// live against Composio's tool catalog — see composio.ts's header notes), so
// a Composio-synced event is left unchanged externally and the response
// reports it as `notSupported` rather than guessing at an unverified call.
// Local persistence always succeeds/fails independently of external sync.
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

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);
  const legacyProviders = await listHealthyLegacyProviders(user.id, connections ?? []);

  async function updateExternal(
    source: "google" | "outlook",
    operation: () => Promise<boolean>,
  ): Promise<CalendarSyncOutcome> {
    try {
      const ok = await timedProviderOperation(
        { area: "calendar", provider: source, transport: "direct", operation: "update_event", timeoutMs: 8_000, slowMs: 2_000 },
        operation,
      );
      if (ok) return { ok: true };
      return { ok: false, error: { source, transport: "direct", message: `${source === "google" ? "Google Calendar" : "Outlook"} update failed.` } };
    } catch {
      return { ok: false, error: { source, transport: "direct", message: `${source === "google" ? "Google Calendar" : "Outlook"} update failed.` } };
    }
  }

  const notSupported: Array<"google" | "outlook"> = [];
  const syncInput = { title, start_at, end_at, description: description ?? undefined };

  function planExternalUpdate(
    source: "google" | "outlook",
    externalId: string | null,
    hasLegacy: boolean,
    operation: () => Promise<boolean>,
  ): Promise<CalendarSyncOutcome> {
    if (!externalId) return Promise.resolve({ ok: true });
    if (!hasLegacy) {
      notSupported.push(source);
      return Promise.resolve({ ok: true });
    }
    return updateExternal(source, operation);
  }

  const [googleResult, outlookResult] = await Promise.all([
    planExternalUpdate("google", gcal_event_id, legacyProviders.has("google"), () =>
      updateGoogleEvent(user.id, gcal_event_id as string, syncInput),
    ),
    planExternalUpdate("outlook", outlook_event_id, legacyProviders.has("outlook"), () =>
      updateOutlookEvent(user.id, outlook_event_id as string, syncInput),
    ),
  ]);
  const errors = [
    ...(googleResult.error ? [googleResult.error] : []),
    ...(outlookResult.error ? [outlookResult.error] : []),
  ];

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

  const legacyProviders = await listHealthyLegacyProviders(user.id, connections ?? []);
  let composioAccounts: Awaited<ReturnType<typeof listComposioCalendarAccounts>> = [];
  if (row.gcal_event_id || row.outlook_event_id) {
    try {
      composioAccounts = await listComposioCalendarAccounts(user.id);
    } catch (error) {
      captureScheduleFailure(error, "delete_load_composio_connections", eventId);
      return NextResponse.json({ error: "Could not load calendar connections" }, { status: 500 });
    }
  }
  const googleTransport = resolveCleanupTransport("google", legacyProviders, composioAccounts);
  const outlookTransport = resolveCleanupTransport("outlook", legacyProviders, composioAccounts);

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
    if (googleTransport.transport === "direct") {
      googleDeletePromise = deleteExternal("google", "direct", () => deleteGoogleEvent(user.id, gcalEventId));
    } else if (googleTransport.transport === "composio") {
      const connectedAccountId = googleTransport.connectedAccountId;
      googleDeletePromise = deleteExternal("google", "composio", () =>
        deleteComposioEvent("googlecalendar", connectedAccountId, user.id, gcalEventId),
      );
    } else {
      missingCleanupConnection = true;
    }
  }

  let outlookDeletePromise: Promise<CalendarDeleteResult> = Promise.resolve({ ok: true });
  if (row.outlook_event_id) {
    const outlookEventId = row.outlook_event_id;
    if (outlookTransport.transport === "direct") {
      outlookDeletePromise = deleteExternal("outlook", "direct", () => deleteOutlookEvent(user.id, outlookEventId));
    } else if (outlookTransport.transport === "composio") {
      const connectedAccountId = outlookTransport.connectedAccountId;
      outlookDeletePromise = deleteExternal("outlook", "composio", () =>
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
