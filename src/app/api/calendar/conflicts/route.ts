import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listComposioCalendarAccounts, queryFreeBusy, findFreeSlots } from "@/lib/calendar/composio";
import { logRouteTiming, timedProviderOperation } from "@/lib/observability/providerTiming";

// POST /api/calendar/conflicts { start_at, end_at }
// Called after a schedule_event saves — checks for overlaps against the
// user's local schedule plus (if Google Calendar is connected via Composio)
// their actual external calendar, and suggests alternative slots when a
// conflict is found. Intentionally a direct synchronous check rather than a
// Make scenario: Make's webhook round-trip would only add latency here, with
// no benefit, since this needs an inline answer for the just-saved event.
//
// Scoped to Google Calendar only — Outlook's Composio toolkit has no
// confirmed free/busy tool slug (see src/lib/calendar/composio.ts).
export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ conflict: false, conflictingTitles: [], suggestions: [] });

  let body: { start_at?: unknown; end_at?: unknown; excludeEventId?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { start_at, end_at, excludeEventId } = body;
  if (typeof start_at !== "string" || typeof end_at !== "string") {
    return NextResponse.json({ error: "start_at and end_at are required" }, { status: 400 });
  }

  let localQuery = supabase
    .from("schedule_events")
    .select("id, title, start_at, end_at")
    .eq("user_id", user.id)
    .lt("start_at", end_at)
    .gt("end_at", start_at);
  if (typeof excludeEventId === "string") localQuery = localQuery.neq("id", excludeEventId);
  const { data: localOverlaps } = await localQuery;

  const composioAccounts = await listComposioCalendarAccounts(user.id);
  const googleAccount = composioAccounts.find((a) => a.provider === "googlecalendar");

  let externalError: string | null = null;
  const externalBusy = googleAccount
    ? await timedProviderOperation(
        {
          area: "calendar",
          provider: "google",
          transport: "composio",
          operation: "free_busy",
          timeoutMs: 7_000,
          slowMs: 1_500,
        },
        () => queryFreeBusy(googleAccount.connectedAccountId, user.id, start_at, end_at),
      ).catch((error) => {
        externalError = "Google Calendar free/busy could not be checked.";
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          tags: { area: "schedule", op: "check_conflicts", provider: "google", transport: "composio" },
        });
        return [];
      })
    : [];

  const conflictingTitles = (localOverlaps ?? []).map((e) => e.title);
  const hasExternalConflict = externalBusy.length > 0;
  const conflict = conflictingTitles.length > 0 || hasExternalConflict;

  let suggestions: Array<{ start_at: string; end_at: string }> = [];
  if (conflict && googleAccount) {
    const windowStart = new Date(start_at);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 2);
    const slots = await timedProviderOperation(
      {
        area: "calendar",
        provider: "google",
        transport: "composio",
        operation: "find_free_slots",
        timeoutMs: 7_000,
        slowMs: 1_500,
      },
      () => findFreeSlots(
        googleAccount.connectedAccountId,
        user.id,
        windowStart.toISOString(),
        windowEnd.toISOString(),
      ),
    ).catch((error) => {
      externalError = externalError ?? "Google Calendar free slots could not be checked.";
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { area: "schedule", op: "find_free_slots", provider: "google", transport: "composio" },
      });
      return [];
    });
    suggestions = slots.slice(0, 3).map((s) => ({ start_at: s.start, end_at: s.end }));
  }

  logRouteTiming("/api/calendar/conflicts", routeStartedAt, {
    conflict,
    externalChecked: !!googleAccount && !externalError,
  });

  return NextResponse.json({
    conflict,
    conflictingTitles: hasExternalConflict ? [...conflictingTitles, "an event on your Google Calendar"] : conflictingTitles,
    suggestions,
    externalChecked: !!googleAccount && !externalError,
    partial: !!externalError,
    errors: externalError ? [{ source: "google", transport: "composio", message: externalError }] : [],
  });
}
