import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { createGoogleEvent } from "@/lib/calendar/google";
import { createOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, createComposioEvent } from "@/lib/calendar/composio";
import { listHealthyLegacyProviders } from "@/lib/calendar/legacy-providers";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";

type CalendarSyncError = {
  source: "google" | "outlook";
  transport: "direct" | "composio";
  code: "timeout" | "network" | "provider_error";
  message: string;
};
type CalendarSyncResult = { id: string | null; error?: CalendarSyncError };
type ScheduleEventRow = {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
};

function statusFrom(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function syncError(source: "google" | "outlook", transport: "direct" | "composio", error: unknown): CalendarSyncError {
  const status = statusFrom(error);
  const isTimeout = error instanceof Error && (error.name === "ProviderTimeoutError" || error.name === "TimeoutError");
  return {
    source,
    transport,
    code: isTimeout ? "timeout" : status && status >= 500 ? "provider_error" : "network",
    message: isTimeout
      ? `${source === "google" ? "Google Calendar" : "Outlook"} sync timed out.`
      : `${source === "google" ? "Google Calendar" : "Outlook"} sync failed.`,
  };
}

// POST /api/calendar/sync
// Creates the given schedule_event in all connected calendars and
// writes the external IDs back to the schedule_events row. A Composio
// connection is preferred over a legacy direct-OAuth one for the same
// provider (Composio is the canonical connect path), so the event is never
// created twice in the same calendar.
export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { eventId?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { eventId } = body;
  if (typeof eventId !== "string") {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  }

  const { data: scheduleEvent, error: eventError } = await supabase
    .from("schedule_events")
    .select("id,title,description,start_at,end_at")
    .eq("id", eventId)
    .eq("user_id", user.id)
    .maybeSingle();

  const ownedEvent = scheduleEvent as ScheduleEventRow | null;

  if (eventError) {
    Sentry.captureException(eventError, {
      tags: { area: "schedule", op: "load_event_for_calendar_sync" },
      extra: { eventId },
    });
    return NextResponse.json({ error: "Could not load this schedule event." }, { status: 500 });
  }
  if (!ownedEvent) {
    return NextResponse.json({ error: "Schedule event not found" }, { status: 404 });
  }

  const startTime = Date.parse(ownedEvent.start_at);
  const endTime = Date.parse(ownedEvent.end_at);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    return NextResponse.json({ error: "Schedule event has an invalid time range." }, { status: 400 });
  }

  const event = {
    title: ownedEvent.title,
    start_at: ownedEvent.start_at,
    end_at: ownedEvent.end_at,
    description: ownedEvent.description ?? undefined,
  };

  const { data: connections, error: connectionsError } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);
  if (connectionsError) {
    Sentry.captureException(connectionsError, {
      tags: { area: "schedule", op: "load_calendar_connections", route: "/api/calendar/sync" },
      extra: { eventId },
    });
    return NextResponse.json(
      { error: "Calendar connections could not be loaded. Try again in a moment.", code: "connection_lookup_failed" },
      { status: 500 },
    );
  }

  const legacyProviders = await listHealthyLegacyProviders(user.id, connections ?? []);
  let composioAccounts: Awaited<ReturnType<typeof listComposioCalendarAccounts>> = [];
  try {
    composioAccounts = await listComposioCalendarAccounts(user.id);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { area: "schedule", op: "list_composio_calendar_accounts", route: "/api/calendar/sync" },
      extra: { eventId },
    });
    return NextResponse.json(
      { error: "Connected calendar accounts could not be refreshed. Try again in a moment.", code: "connection_lookup_failed" },
      { status: 502 },
    );
  }

  // Composio wins: a Composio calendar connection is used ahead of any legacy
  // direct-OAuth one for the same provider; the legacy path is a fallback only
  // for a provider with no Composio connection. (Prod has zero legacy rows.)
  const composioGoogle = composioAccounts.find((a) => a.provider === "googlecalendar");
  const composioOutlook = composioAccounts.find((a) => a.provider === "outlook");

  async function syncSource(
    source: "google" | "outlook",
    transport: "direct" | "composio",
    operation: () => Promise<string | null>,
  ): Promise<CalendarSyncResult> {
    try {
      const id = await timedProviderOperation(
        {
          area: "calendar",
          provider: source,
          transport,
          operation: "create_event",
          timeoutMs: 9_000,
          slowMs: 2_000,
        },
        operation,
      );
      return { id };
    } catch (error) {
      return { id: null, error: syncError(source, transport, error) };
    }
  }

  const [googleSync, outlookSync] = await Promise.all([
    composioGoogle
      ? syncSource("google", "composio", () => createComposioEvent("googlecalendar", composioGoogle.connectedAccountId, user.id, event))
      : legacyProviders.has("google")
        ? syncSource("google", "direct", () => createGoogleEvent(user.id, event))
        : Promise.resolve<CalendarSyncResult>({ id: null }),
    composioOutlook
      ? syncSource("outlook", "composio", () => createComposioEvent("outlook", composioOutlook.connectedAccountId, user.id, event))
      : legacyProviders.has("outlook")
        ? syncSource("outlook", "direct", () => createOutlookEvent(user.id, event))
        : Promise.resolve<CalendarSyncResult>({ id: null }),
  ]);

  const gcalId = googleSync.id;
  const outlookId = outlookSync.id;
  const errors = [
    ...(googleSync.error ? [googleSync.error] : []),
    ...(outlookSync.error ? [outlookSync.error] : []),
  ];

  // Reserve Sentry for 5xx-class/unexpected failures — expected outcomes
  // (timeout, network hiccup) are still worth a tagged event here since a
  // silently-unsynced event is exactly the kind of thing a human should see,
  // but they're not app bugs, so this stays a single event per failure, not
  // an escalating alert.
  for (const err of errors) {
    Sentry.captureException(new Error("Schedule calendar event create sync failed"), {
      tags: { area: "schedule", op: "sync_event", provider: err.source, transport: err.transport, code: err.code },
      extra: { eventId },
    });
  }

  // Write IDs back — only update columns where sync succeeded
  const patch: Record<string, string> = {};
  if (gcalId) patch.gcal_event_id = gcalId;
  if (outlookId) patch.outlook_event_id = outlookId;

  if (Object.keys(patch).length) {
    const { error: persistError } = await supabase
      .from("schedule_events")
      .update(patch as Database["public"]["Tables"]["schedule_events"]["Update"])
      .eq("id", eventId)
      .eq("user_id", user.id);
    if (persistError) {
      Sentry.captureException(persistError, {
        tags: { area: "schedule", op: "persist_external_event_ids" },
        extra: { eventId, providers: Object.keys(patch) },
      });
      errors.push({
        source: gcalId ? "google" : "outlook",
        transport: gcalId
          ? (composioGoogle ? "composio" : "direct")
          : (composioOutlook ? "composio" : "direct"),
        code: "network",
        message: "Calendar sync succeeded, but AXIS could not save the external event link.",
      });
    }
  }

  logRouteTiming("/api/calendar/sync", routeStartedAt, {
    google: !!gcalId,
    outlook: !!outlookId,
    partial: errors.length > 0,
  });

  return NextResponse.json({ gcalId, outlookId, partial: errors.length > 0, errors });
}
