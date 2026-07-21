import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { listComposioCalendarAccounts, listComposioEvents } from "@/lib/calendar/composio";
import type { ExternalCalendarEvent } from "@/lib/calendar/types";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";
import { resolveCleanupTransport } from "@/lib/calendar/event-detail";

type CalendarSource = "google" | "outlook";
type ExternalCalendarError = {
  source: CalendarSource;
  transport: "composio";
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

function calendarError(source: CalendarSource, transport: "composio", error: unknown): ExternalCalendarError {
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
// Pulls the user's actual events from their Composio-connected calendars
// (read-only — these never get written to schedule_events) so connecting a
// calendar surfaces real content instead of just a connected badge. Calendar
// is Composio-only after the direct-adapter removal.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ events: [] });

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end are required" }, { status: 400 });

  const displaySource = (toolkit: "googlecalendar" | "outlook") => (toolkit === "googlecalendar" ? "google" : "outlook");
  // Calendar is Composio-only after the direct-adapter removal.
  let composioAccounts: Awaited<ReturnType<typeof listComposioCalendarAccounts>> = [];
  let cachePersistenceError = false;
  try {
    composioAccounts = await listComposioCalendarAccounts(user.id);
  } catch (composioError) {
    Sentry.captureException(composioError instanceof Error ? composioError : new Error(String(composioError)), {
      tags: { area: "schedule", route: "/api/calendar/external", op: "list_composio_accounts" },
    });
    return NextResponse.json(
      {
        events: [],
        partial: true,
        errors: [{
          source: "google",
          transport: "composio",
          code: "network",
          message: "Calendar accounts could not be fully loaded.",
        }],
        fetchedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }

  async function loadSource<T>(
    source: CalendarSource,
    operation: () => Promise<T[]>,
  ): Promise<ExternalCalendarResult<T>> {
    try {
      const events = await timedProviderOperation(
        {
          area: "calendar",
          provider: source,
          transport: "composio",
          operation: "list_events",
          captureFailures: false,
          timeoutMs: 7_000,
          slowMs: 1_500,
        },
        operation,
      );
      return { events };
    } catch (error) {
      return { events: [], error: calendarError(source, "composio", error) };
    }
  }

  const composioLists = await Promise.all(
    composioAccounts.map((a) => {
      const source = displaySource(a.provider);
      return loadSource(source, async () =>
        (await listComposioEvents(a.provider, a.connectedAccountId, user.id, start, end))
          .map((e) => ({ ...e, source })),
      );
    }),
  );

  const events = composioLists.flatMap((result) => result.events);
  const errors = composioLists.flatMap((result) => (result.error ? [result.error] : []));

  for (const err of errors) {
    Sentry.captureException(new Error("Schedule external calendar list failed"), {
      tags: { area: "schedule", op: "list_external_events", provider: err.source, transport: err.transport, code: err.code },
    });
  }

  const fetchedAt = new Date().toISOString();

  // CAL-3: write-through to calendar_event_cache so the next Schedule load
  // can render instantly from cache and revalidate this route in the
  // background, instead of blocking first paint on live provider calls.
  // Reuses the same resolveCleanupTransport helper delete/update use, since
  // "which transport supplied this data" is the same question.
  const composioResultBySource = new Map<CalendarSource, ExternalCalendarResult<ExternalCalendarEvent>>();
  composioAccounts.forEach((account, i) => composioResultBySource.set(displaySource(account.provider), composioLists[i]));

  const googleTransport = resolveCleanupTransport("google", composioAccounts);
  const outlookTransport = resolveCleanupTransport("outlook", composioAccounts);

  function outcomeFor(source: CalendarSource, transport: "composio" | "none") {
    if (transport === "composio") return composioResultBySource.get(source) ?? null;
    return null;
  }

  const cacheRows: Array<{
    user_id: string; source: CalendarSource; transport: "composio";
    range_start: string; range_end: string; events: unknown[]; error: null;
    fetched_at: string; updated_at: string;
  }> = [];
  const errorOnlyUpdates: Array<{ source: CalendarSource; error: ExternalCalendarError }> = [];

  for (const [source, resolved] of [["google", googleTransport], ["outlook", outlookTransport]] as const) {
    if (resolved.transport === "none") continue;
    const outcome = outcomeFor(source, resolved.transport);
    if (!outcome) continue;
    if (outcome.error) {
      errorOnlyUpdates.push({ source, error: outcome.error });
    } else {
      cacheRows.push({
        user_id: user.id,
        source,
        transport: resolved.transport,
        range_start: start,
        range_end: end,
        events: outcome.events,
        error: null,
        fetched_at: fetchedAt,
        updated_at: fetchedAt,
      });
    }
  }

  try {
    if (cacheRows.length > 0) {
      const { error: cacheError } = await supabase
        .from("calendar_event_cache")
        .upsert(cacheRows as Database["public"]["Tables"]["calendar_event_cache"]["Insert"][], { onConflict: "user_id,source" });
      if (cacheError) throw cacheError;
    }
    // Errored sources keep their last-known events (no overwrite) — only the
    // error/freshness metadata updates, and only if a cache row already
    // exists (nothing to attach an error-only row to on a first-ever fetch).
    for (const update of errorOnlyUpdates) {
      const { error: updateError } = await supabase
        .from("calendar_event_cache")
        .update({ error: update.error, updated_at: fetchedAt })
        .eq("user_id", user.id)
        .eq("source", update.source);
      if (updateError) throw updateError;
    }
  } catch (cacheError) {
    cachePersistenceError = true;
    Sentry.captureException(cacheError instanceof Error ? cacheError : new Error(String(cacheError)), {
      tags: { area: "schedule", op: "write_calendar_event_cache" },
    });
  }

  logRouteTiming("/api/calendar/external", routeStartedAt, {
    events: events.length,
    partial: errors.length > 0 || cachePersistenceError,
  });

  return NextResponse.json({
    events,
    partial: errors.length > 0 || cachePersistenceError,
    errors,
    cache: { persisted: !cachePersistenceError },
    fetchedAt,
  });
}
