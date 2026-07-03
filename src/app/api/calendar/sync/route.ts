import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { createGoogleEvent } from "@/lib/calendar/google";
import { createOutlookEvent } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, createComposioEvent } from "@/lib/calendar/composio";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";

type CalendarSyncError = {
  source: "google" | "outlook";
  transport: "direct" | "composio";
  code: "timeout" | "network" | "provider_error";
  message: string;
};
type CalendarSyncResult = { id: string | null; error?: CalendarSyncError };

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
// writes the external IDs back to the schedule_events row. Legacy
// direct-OAuth calendars are preferred over Composio-connected ones for
// the same provider, to avoid creating the event twice in the same calendar.
export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
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
    legacyProviders.has("google")
      ? syncSource("google", "direct", () => createGoogleEvent(user.id, event))
      : composioGoogle
        ? syncSource("google", "composio", () => createComposioEvent("googlecalendar", composioGoogle.connectedAccountId, user.id, event))
        : Promise.resolve<CalendarSyncResult>({ id: null }),
    legacyProviders.has("outlook")
      ? syncSource("outlook", "direct", () => createOutlookEvent(user.id, event))
      : composioOutlook
        ? syncSource("outlook", "composio", () => createComposioEvent("outlook", composioOutlook.connectedAccountId, user.id, event))
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
    await supabase.from("schedule_events").update(patch).eq("id", eventId).eq("user_id", user.id);
  }

  logRouteTiming("/api/calendar/sync", routeStartedAt, {
    google: !!gcalId,
    outlook: !!outlookId,
    partial: errors.length > 0,
  });

  return NextResponse.json({ gcalId, outlookId, partial: errors.length > 0, errors });
}
