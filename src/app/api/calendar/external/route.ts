import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listGoogleEvents, type ExternalCalendarEvent } from "@/lib/calendar/google";
import { listOutlookEvents } from "@/lib/calendar/outlook";
import { listComposioCalendarAccounts, listComposioEvents } from "@/lib/calendar/composio";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";

type CalendarSource = "google" | "outlook";
type ExternalCalendarError = {
  source: CalendarSource;
  transport: "direct" | "composio";
  code: "timeout" | "network" | "provider_error";
  message: string;
};
type ExternalCalendarResult<T> = { events: T[]; error?: ExternalCalendarError };

function statusFrom(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function calendarError(source: CalendarSource, transport: "direct" | "composio", error: unknown): ExternalCalendarError {
  const status = statusFrom(error);
  const isTimeout = error instanceof Error && (error.name === "ProviderTimeoutError" || error.name === "TimeoutError");
  return {
    source,
    transport,
    code: isTimeout ? "timeout" : status && status >= 500 ? "provider_error" : "network",
    message: isTimeout
      ? `${source === "google" ? "Google Calendar" : "Outlook"} took too long to respond.`
      : `${source === "google" ? "Google Calendar" : "Outlook"} events could not be refreshed.`,
  };
}

// GET /api/calendar/external?start=ISO&end=ISO
// Pulls the user's actual events from any connected external calendars
// (read-only — these never get written to schedule_events) so connecting
// Google/Outlook surfaces real content instead of just a connected badge.
// Merges legacy direct-OAuth calendars with Composio-connected ones —
// if both exist for the same provider, only the legacy one is read, to
// avoid showing duplicate events from the same calendar twice.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ events: [] });

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end are required" }, { status: 400 });

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);

  const providers = new Set((connections ?? []).map((c) => c.provider));
  const displaySource = (toolkit: "googlecalendar" | "outlook") => (toolkit === "googlecalendar" ? "google" : "outlook");
  const composioAccounts = (await listComposioCalendarAccounts(user.id)).filter(
    (a) => !providers.has(displaySource(a.provider)),
  );

  async function loadSource<T>(
    source: CalendarSource,
    transport: "direct" | "composio",
    operation: () => Promise<T[]>,
  ): Promise<ExternalCalendarResult<T>> {
    try {
      const events = await timedProviderOperation(
        {
          area: "calendar",
          provider: source,
          transport,
          operation: "list_events",
          timeoutMs: 7_000,
          slowMs: 1_500,
        },
        operation,
      );
      return { events };
    } catch (error) {
      return { events: [], error: calendarError(source, transport, error) };
    }
  }

  const [google, outlook, composioLists] = await Promise.all([
    providers.has("google")
      ? loadSource("google", "direct", () => listGoogleEvents(user.id, start, end))
      : Promise.resolve<ExternalCalendarResult<ExternalCalendarEvent>>({ events: [] }),
    providers.has("outlook")
      ? loadSource("outlook", "direct", () => listOutlookEvents(user.id, start, end))
      : Promise.resolve<ExternalCalendarResult<ExternalCalendarEvent>>({ events: [] }),
    Promise.all(
      composioAccounts.map((a) => {
        const source = displaySource(a.provider);
        return loadSource(source, "composio", async () =>
          (await listComposioEvents(a.provider, a.connectedAccountId, user.id, start, end))
            .map((e) => ({ ...e, source })),
        );
      }),
    ),
  ]);

  const events = [
    ...google.events.map((e) => ({ ...e, source: "google" as const })),
    ...outlook.events.map((e) => ({ ...e, source: "outlook" as const })),
    ...composioLists.flatMap((result) => result.events),
  ];
  const errors = [
    ...(google.error ? [google.error] : []),
    ...(outlook.error ? [outlook.error] : []),
    ...composioLists.flatMap((result) => (result.error ? [result.error] : [])),
  ];

  logRouteTiming("/api/calendar/external", routeStartedAt, {
    events: events.length,
    partial: errors.length > 0,
  });

  return NextResponse.json({
    events,
    partial: errors.length > 0,
    errors,
    fetchedAt: new Date().toISOString(),
  });
}
