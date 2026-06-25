// Composio-backed Calendar accounts, mirroring src/lib/mail/composio.ts.
// Lives alongside google.ts / outlook.ts (the legacy direct-OAuth path) and
// is additive: events from a Composio-connected calendar show up alongside
// legacy-OAuth calendars in the same Schedule view.
//
// Outlook's calendar tools live on the SAME "outlook" toolkit/connected
// account Mail already uses — a user with Outlook connected for Mail
// already has calendar access via the existing connection, no second OAuth
// grant needed.
//
// NOTE on verification status: every tool slug AND its input argument
// schema below were confirmed live against Composio's /tools/{slug}
// endpoint. What was NOT verified live is the *response* shape for each
// call (would require a real connected account) — normalizers below try
// the native Google/Microsoft API shapes since Composio's calendar tools
// are documented to stay close to the underlying REST APIs, same approach
// mail/composio.ts took for Gmail/Outlook mail tools.
//
// Two real API quirks baked into the arguments below, confirmed live:
// - GOOGLECALENDAR_EVENTS_LIST uses camelCase (timeMin/timeMax/orderBy/
//   calendarId) while GOOGLECALENDAR_CREATE_EVENT/DELETE_EVENT use
//   snake_case (calendar_id, event_id, start_datetime) — inconsistent
//   across Composio's own Google Calendar tools, not a typo here.
// - GOOGLECALENDAR_CREATE_EVENT takes a *naive* start_datetime (no Z/
//   offset) + timezone field + event_duration_hour/event_duration_minutes
//   — it has no end_datetime parameter at all, unlike Outlook's create tool.
import { createClient } from "@/lib/supabase/server";
import { executeTool } from "@/lib/integrations/composio";
import type { ExternalCalendarEvent } from "./google";

export type CalendarToolkit = "googlecalendar" | "outlook";

const LIST_EVENTS_TOOL: Record<CalendarToolkit, string> = {
  googlecalendar: "GOOGLECALENDAR_EVENTS_LIST",
  outlook: "OUTLOOK_OUTLOOK_LIST_EVENTS",
};
const CREATE_EVENT_TOOL: Record<CalendarToolkit, string> = {
  googlecalendar: "GOOGLECALENDAR_CREATE_EVENT",
  outlook: "OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT",
};
const DELETE_EVENT_TOOL: Record<CalendarToolkit, string> = {
  googlecalendar: "GOOGLECALENDAR_DELETE_EVENT",
  outlook: "OUTLOOK_OUTLOOK_DELETE_EVENT",
};

export type ComposioCalendarAccount = {
  provider: CalendarToolkit;
  calendarEmail: string;
  via: "composio";
  connectedAccountId: string;
};

export async function listComposioCalendarAccounts(userId: string): Promise<ComposioCalendarAccount[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("composio_connections")
    .select("toolkit, connected_account_id, account_label")
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .in("toolkit", ["googlecalendar", "outlook"])
    .not("account_label", "is", null);

  return (data ?? []).map((row) => ({
    provider: row.toolkit as CalendarToolkit,
    calendarEmail: row.account_label as string,
    via: "composio" as const,
    connectedAccountId: row.connected_account_id as string,
  }));
}

function normalizeGcalEvent(e: Record<string, unknown>): ExternalCalendarEvent | null {
  const id = e.id as string | undefined;
  if (!id || e.status === "cancelled") return null;
  const start = e.start as { dateTime?: string; date?: string } | undefined;
  const end = e.end as { dateTime?: string; date?: string } | undefined;
  const startVal = start?.dateTime ?? start?.date;
  const endVal = end?.dateTime ?? end?.date;
  if (!startVal || !endVal) return null;
  return {
    externalId: id,
    title: (e.summary as string) || "(No title)",
    start_at: startVal,
    end_at: endVal,
    description: (e.description as string) ?? null,
    all_day: !start?.dateTime,
  };
}

function normalizeOutlookCalEvent(e: Record<string, unknown>): ExternalCalendarEvent | null {
  const id = e.id as string | undefined;
  const start = e.start as { dateTime?: string } | undefined;
  const end = e.end as { dateTime?: string } | undefined;
  if (!id || !start?.dateTime || !end?.dateTime) return null;
  return {
    externalId: id,
    title: (e.subject as string) || "(No title)",
    start_at: `${start.dateTime}Z`,
    end_at: `${end.dateTime}Z`,
    description: (e.bodyPreview as string) ?? null,
    all_day: !!e.isAllDay,
  };
}

export async function listComposioEvents(
  toolkit: CalendarToolkit,
  connectedAccountId: string,
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<ExternalCalendarEvent[]> {
  const res = await executeTool({
    toolSlug: LIST_EVENTS_TOOL[toolkit],
    connectedAccountId,
    userId,
    arguments:
      toolkit === "googlecalendar"
        ? { calendarId: "primary", timeMin, timeMax, orderBy: "startTime" }
        : { filter: `start/dateTime ge '${timeMin}' and end/dateTime le '${timeMax}'`, orderby: ["start/dateTime"] },
  });
  if (!res.successful) return [];
  const data = res.data as Record<string, unknown>;
  const rawItems = (data.items ?? data.value ?? []) as Record<string, unknown>[];
  const normalize = toolkit === "googlecalendar" ? normalizeGcalEvent : normalizeOutlookCalEvent;
  return rawItems.map(normalize).filter((e): e is ExternalCalendarEvent => e !== null);
}

function toNaiveDatetime(iso: string): string {
  return iso.replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/, "");
}

// Clamped to 24h — ScheduleModule's add-event form only allows same-day
// start/end, so this never truncates in practice today. A multi-day event
// passed from a future caller would silently lose any time beyond 24h.
function computeDuration(startAt: string, endAt: string): { hour: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000));
  return { hour: Math.min(24, Math.floor(totalMinutes / 60)), minutes: totalMinutes % 60 };
}

export async function createComposioEvent(
  toolkit: CalendarToolkit,
  connectedAccountId: string,
  userId: string,
  event: { title: string; start_at: string; end_at: string; description?: string },
): Promise<string | null> {
  let args: Record<string, unknown>;
  if (toolkit === "googlecalendar") {
    const { hour, minutes } = computeDuration(event.start_at, event.end_at);
    args = {
      calendar_id: "primary",
      summary: event.title,
      description: event.description ?? "",
      start_datetime: toNaiveDatetime(event.start_at),
      timezone: "UTC",
      event_duration_hour: hour,
      event_duration_minutes: minutes,
    };
  } else {
    args = {
      subject: event.title,
      body: event.description ?? "",
      start_datetime: event.start_at,
      end_datetime: event.end_at,
      time_zone: "UTC",
    };
  }
  const res = await executeTool({ toolSlug: CREATE_EVENT_TOOL[toolkit], connectedAccountId, userId, arguments: args });
  if (!res.successful) return null;
  const data = res.data as Record<string, unknown>;
  return (data.id as string) ?? null;
}

export async function deleteComposioEvent(
  toolkit: CalendarToolkit,
  connectedAccountId: string,
  userId: string,
  externalEventId: string,
): Promise<boolean> {
  const res = await executeTool({
    toolSlug: DELETE_EVENT_TOOL[toolkit],
    connectedAccountId,
    userId,
    arguments:
      toolkit === "googlecalendar"
        ? { calendar_id: "primary", event_id: externalEventId }
        : { event_id: externalEventId },
  });
  return res.successful;
}

// Google Calendar only — Outlook has no confirmed free/busy tool slug, so
// the conflict-detection feature (src/app/api/calendar/conflicts) scopes
// itself to Google Calendar rather than guessing at an unverified slug.
export async function queryFreeBusy(
  connectedAccountId: string,
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  const res = await executeTool({
    toolSlug: "GOOGLECALENDAR_FREE_BUSY_QUERY",
    connectedAccountId,
    userId,
    arguments: { timeMin, timeMax, items: [{ id: "primary" }] },
  });
  if (!res.successful) return [];
  const data = res.data as Record<string, unknown>;
  const calendars = data.calendars as Record<string, { busy?: Array<{ start: string; end: string }> }> | undefined;
  return calendars?.primary?.busy ?? [];
}

export async function findFreeSlots(
  connectedAccountId: string,
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  const res = await executeTool({
    toolSlug: "GOOGLECALENDAR_FIND_FREE_SLOTS",
    connectedAccountId,
    userId,
    arguments: { items: ["primary"], time_min: timeMin, time_max: timeMax, timezone: "UTC" },
  });
  if (!res.successful) return [];
  const data = res.data as Record<string, unknown>;
  const slots = (data.free_slots ?? data.slots ?? data.items ?? []) as Record<string, unknown>[];
  return slots
    .map((s) => ({ start: (s.start as string) ?? (s.start_time as string), end: (s.end as string) ?? (s.end_time as string) }))
    .filter((s): s is { start: string; end: string } => !!s.start && !!s.end);
}
