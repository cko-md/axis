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
import {
  executeVerifiedComposioTool,
  listAuthorizedComposioConnections,
} from "@/lib/integrations/composio-identity";
import {
  GOOGLECALENDAR_COMPOSIO_TOOLS,
  OUTLOOK_CALENDAR_COMPOSIO_TOOLS,
} from "@/lib/integrations/composio-calendar-tools";
import { normalizeAllDayTimestamp } from "./event-dates";
import type { ExternalCalendarEvent } from "./types";

export type CalendarToolkit = "googlecalendar" | "outlook";

const LIST_EVENTS_TOOL: Record<CalendarToolkit, string> = {
  googlecalendar: GOOGLECALENDAR_COMPOSIO_TOOLS[0],
  outlook: OUTLOOK_CALENDAR_COMPOSIO_TOOLS[0],
};

export type ComposioCalendarAccount = {
  provider: CalendarToolkit;
  calendarEmail: string;
  via: "composio";
  /** Opaque Axis-owned connection identifier. Never a Composio account id. */
  connectionId: string;
};

export class ComposioCalendarMutationDisabledError extends Error {
  readonly status = 403;
  readonly code = "provider_mutations_disabled" as const;

  constructor(operation: "create_event" | "delete_event") {
    super(`Composio Calendar ${operation} is disabled during provider-identity containment`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function unwrapEventList(data: Record<string, unknown>): Record<string, unknown>[] {
  const nested = asRecord(data.data);
  const responseData = asRecord(data.response_data);
  const nestedResponse = asRecord(nested?.response_data);
  const candidates = [
    data.items,
    data.value,
    data.events,
    nested?.items,
    nested?.value,
    nested?.events,
    responseData?.items,
    responseData?.value,
    responseData?.events,
    nestedResponse?.items,
    nestedResponse?.value,
    Array.isArray(data.data) ? data.data : null,
    Array.isArray(data.response_data) ? data.response_data : null,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as Record<string, unknown>[];
  }
  return [];
}

function composioCalendarError(operation: string): Error & { status: number } {
  const err = new Error(`Composio Calendar ${operation} failed`) as Error & { status: number };
  err.status = 502;
  return err;
}

export async function listComposioCalendarAccounts(userId: string): Promise<ComposioCalendarAccount[]> {
  // This is local private-authority membership only. It deliberately does not
  // contact Composio; a fresh remote proof happens immediately before a
  // read-only tool dispatch in executeVerifiedComposioTool.
  const connections = await listAuthorizedComposioConnections(userId, ["googlecalendar", "outlook"]);

  // Defensive dedup: calendar toolkits are single-account by design (see the
  // legacyProviders.has("google")/has("outlook") singular checks throughout
  // this domain). A reconnect could still leave more than one ACTIVE row per
  // toolkit (Composio issues a fresh account binding every grant) —
  // keep only the newest so an old, possibly-stale grant doesn't double every
  // event in the merged calendar view.
  const seen = new Set<string>();
  const deduped = connections.filter((connection) => {
    if (seen.has(connection.toolkit)) return false;
    seen.add(connection.toolkit);
    return true;
  });

  return deduped.map((connection) => ({
    provider: connection.toolkit as CalendarToolkit,
    calendarEmail: connection.accountLabel ?? "Connected calendar",
    via: "composio" as const,
    connectionId: connection.id,
  }));
}

export function normalizeGcalEvent(e: Record<string, unknown>): ExternalCalendarEvent | null {
  const id = e.id as string | undefined;
  if (!id || e.status === "cancelled") return null;
  const start = e.start as { dateTime?: string; date?: string } | undefined;
  const end = e.end as { dateTime?: string; date?: string } | undefined;
  const attendees = (e.attendees as Array<{ displayName?: string; email?: string }> | undefined) ?? [];
  const allDay = !start?.dateTime;
  const startVal = start?.dateTime ?? start?.date;
  const endVal = end?.dateTime ?? end?.date;
  if (!startVal || !endVal) return null;
  return {
    externalId: id,
    title: (e.summary as string) || "(No title)",
    start_at: allDay ? normalizeAllDayTimestamp(startVal) : startVal,
    end_at: allDay ? normalizeAllDayTimestamp(endVal) : endVal,
    description: (e.description as string) ?? null,
    location: (e.location as string) ?? null,
    attendees: attendees
      .map((attendee) => attendee.displayName || attendee.email)
      .filter((attendee): attendee is string => !!attendee),
    all_day: allDay,
  };
}

function formatOutlookDateTime(value: string, dateOnly: boolean): string {
  if (dateOnly) return value.includes("T") ? value : `${value}T00:00:00Z`;
  if (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) return value;
  return `${value}Z`;
}

export function normalizeOutlookCalEvent(e: Record<string, unknown>): ExternalCalendarEvent | null {
  const id = e.id as string | undefined;
  const start = e.start as { dateTime?: string; date?: string } | undefined;
  const end = e.end as { dateTime?: string; date?: string } | undefined;
  const location = e.location as { displayName?: string } | undefined;
  const attendees = (e.attendees as Array<{ emailAddress?: { name?: string; address?: string } }> | undefined) ?? [];
  const startDateOnly = !start?.dateTime && !!start?.date;
  const endDateOnly = !end?.dateTime && !!end?.date;
  const startVal = start?.dateTime ?? start?.date;
  const endVal = end?.dateTime ?? end?.date;
  if (!id || !startVal || !endVal) return null;
  return {
    externalId: id,
    title: (e.subject as string) || "(No title)",
    start_at: formatOutlookDateTime(startVal, startDateOnly),
    end_at: formatOutlookDateTime(endVal, endDateOnly),
    description: (e.bodyPreview as string) ?? null,
    location: location?.displayName ?? null,
    attendees: attendees
      .map((attendee) => attendee.emailAddress?.name || attendee.emailAddress?.address)
      .filter((attendee): attendee is string => !!attendee),
    all_day: !!e.isAllDay || startDateOnly,
  };
}

function outlookDateFilterBounds(timeMin: string, timeMax: string): { dateMin: string; dateMax: string } {
  const toDate = (value: string) => value.slice(0, 10);
  return { dateMin: toDate(timeMin), dateMax: toDate(timeMax) };
}

export async function listComposioEvents(
  toolkit: CalendarToolkit,
  connectionId: string,
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<ExternalCalendarEvent[]> {
  const outlookBounds = outlookDateFilterBounds(timeMin, timeMax);
  const res = await executeVerifiedComposioTool({
    toolSlug: LIST_EVENTS_TOOL[toolkit],
    connectionId,
    toolkit,
    userId,
    arguments:
      toolkit === "googlecalendar"
        // singleEvents:true is REQUIRED alongside orderBy:"startTime" — the Google
        // Calendar API rejects ordering by start time on unexpanded recurring
        // events with a 400 ("The requested ordering is not available for the
        // particular query."). Verified live: every Composio calendar listing
        // call failed with this exact error until singleEvents was added, so
        // Composio-connected Google Calendars never synced/resynced a single
        // event. The direct-OAuth path (src/lib/calendar/google.ts) already sets
        // this correctly.
        ? { calendarId: "primary", timeMin, timeMax, singleEvents: true, orderBy: "startTime" }
        : {
            top: 100,
            filter:
              `(start/dateTime ge '${timeMin}' and start/dateTime le '${timeMax}')` +
              ` or (start/date ge '${outlookBounds.dateMin}' and start/date le '${outlookBounds.dateMax}')`,
            orderby: ["start/dateTime", "start/date"],
            timezone: "UTC",
          },
  });
  if (!res.successful) throw composioCalendarError("list_events");
  const data = res.data as Record<string, unknown>;
  const rawItems = unwrapEventList(data);
  const normalize = toolkit === "googlecalendar" ? normalizeGcalEvent : normalizeOutlookCalEvent;
  return rawItems.map(normalize).filter((e): e is ExternalCalendarEvent => e !== null);
}

export async function createComposioEvent(
  toolkit: CalendarToolkit,
  connectionId: string,
  userId: string,
  event: { title: string; start_at: string; end_at: string; description?: string },
): Promise<string | null> {
  void toolkit;
  void connectionId;
  void userId;
  void event;
  // Phase 1B is deliberately read-only: never turn a verified identity
  // refactor into an outbound provider mutation.
  throw new ComposioCalendarMutationDisabledError("create_event");
}

export async function deleteComposioEvent(
  toolkit: CalendarToolkit,
  connectionId: string,
  userId: string,
  externalEventId: string,
): Promise<boolean> {
  void toolkit;
  void connectionId;
  void userId;
  void externalEventId;
  throw new ComposioCalendarMutationDisabledError("delete_event");
}

// Google Calendar only — Outlook has no confirmed free/busy tool slug, so
// the conflict-detection feature (src/app/api/calendar/conflicts) scopes
// itself to Google Calendar rather than guessing at an unverified slug.
export async function queryFreeBusy(
  connectionId: string,
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  const res = await executeVerifiedComposioTool({
    toolSlug: "GOOGLECALENDAR_FREE_BUSY_QUERY",
    connectionId,
    toolkit: "googlecalendar",
    userId,
    arguments: { timeMin, timeMax, items: [{ id: "primary" }] },
  });
  if (!res.successful) throw composioCalendarError("free_busy");
  const data = res.data as Record<string, unknown>;
  const calendars = data.calendars as Record<string, { busy?: Array<{ start: string; end: string }> }> | undefined;
  return calendars?.primary?.busy ?? [];
}

export async function findFreeSlots(
  connectionId: string,
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  const res = await executeVerifiedComposioTool({
    toolSlug: "GOOGLECALENDAR_FIND_FREE_SLOTS",
    connectionId,
    toolkit: "googlecalendar",
    userId,
    arguments: { items: ["primary"], time_min: timeMin, time_max: timeMax, timezone: "UTC" },
  });
  if (!res.successful) throw composioCalendarError("find_free_slots");
  const data = res.data as Record<string, unknown>;
  const slots = (data.free_slots ?? data.slots ?? data.items ?? []) as Record<string, unknown>[];
  return slots
    .map((s) => ({ start: (s.start as string) ?? (s.start_time as string), end: (s.end as string) ?? (s.end_time as string) }))
    .filter((s): s is { start: string; end: string } => !!s.start && !!s.end);
}
