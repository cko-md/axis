import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { readBoundedJson } from "@/lib/http/boundedJson";
import {
  CalendarMutationError,
  listComposioCalendarAccounts,
  createComposioEvent,
} from "@/lib/calendar/composio";

type ScheduleEventRow = {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
};

// POST /api/calendar/sync
// `createComposioEvent` is the mutation boundary: it durably prepares and
// claims the provider command before dispatch. This route deliberately never
// has a raw provider-create path.
export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_000) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { eventId?: unknown } | null;
  try { body = await readBoundedJson(req, 16_000) as { eventId?: unknown }; } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error && cause.message === "body_too_large" ? "Request body is too large" : "Invalid JSON" }, { status: cause instanceof Error && cause.message === "body_too_large" ? 413 : 400 });
  }
  if (!body || typeof body.eventId !== "string") {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("schedule_events")
    .select("id,title,description,start_at,end_at")
    .eq("id", body.eventId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not load this schedule event." }, { status: 500 });
  const event = data as ScheduleEventRow | null;
  if (!event) return NextResponse.json({ error: "Schedule event not found" }, { status: 404 });
  if (!Number.isFinite(Date.parse(event.start_at)) || !Number.isFinite(Date.parse(event.end_at)) || Date.parse(event.end_at) <= Date.parse(event.start_at)) {
    return NextResponse.json({ error: "Schedule event has an invalid time range." }, { status: 422 });
  }

  let accounts;
  try {
    accounts = await listComposioCalendarAccounts(user.id);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Calendar account lookup failed");
    Sentry.captureException(error, {
      tags: { area: "schedule", op: "list_composio_calendar_accounts", route: "/api/calendar/sync" },
      extra: { eventId: event.id },
    });
    return NextResponse.json({
      error: "Connected calendar accounts could not be refreshed. Try again in a moment.",
      code: "connection_lookup_failed",
    }, { status: 502 });
  }

  const results = await Promise.all(accounts.map(async (account) => {
    const provider = account.provider;
    try {
      await createComposioEvent(provider, account.connectedAccountId, user.id, {
        ...event,
        description: event.description ?? undefined,
      });
      return { provider, state: "succeeded", ok: true, status: 200 };
    } catch (cause) {
      if (cause instanceof CalendarMutationError) {
        if (
          cause.status >= 500
          || cause.state === "outcome_unknown"
          || cause.state === "reconciliation_required"
        ) {
          Sentry.captureException(cause, {
            tags: { area: "calendar", route: "/api/calendar/sync", provider, state: cause.state },
          });
        }
        return { provider, state: cause.state, ok: false, status: cause.status };
      }
      Sentry.captureException(new Error("Calendar create requires reconciliation"), {
        tags: { area: "calendar", route: "/api/calendar/sync", provider, state: "outcome_unknown" },
      });
      return { provider, state: "outcome_unknown", ok: false, status: 202 };
    }
  }));

  return NextResponse.json({
    partial: results.some((result) => !result.ok),
    results: results.map((result) => ({ provider: result.provider, state: result.state, ok: result.ok })),
  }, { status: results.some((result) => result.status === 503) ? 503 : 200 });
}
