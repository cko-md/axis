import { getFreshAccessToken } from "./tokens";
import type { ExternalCalendarEvent } from "./google";
import { timedProviderFetch } from "@/lib/observability/providerTiming";

const BASE = "https://graph.microsoft.com/v1.0/me/events";
const VIEW_BASE = "https://graph.microsoft.com/v1.0/me/calendarView";

function outlookCalendarError(operation: string, status: number): Error & { status: number } {
  const err = new Error(`Outlook Calendar ${operation} failed with ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

export async function listOutlookEvents(
  userId: string,
  startDateTime: string,
  endDateTime: string,
): Promise<ExternalCalendarEvent[]> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return [];

  const url = `${VIEW_BASE}?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$orderby=start/dateTime`;
  const res = await timedProviderFetch(
    url,
    {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
    },
    { area: "calendar", provider: "outlook", operation: "list_events", timeoutMs: 6_000, slowMs: 1_500 },
  );
  if (!res.ok) throw outlookCalendarError("list_events", res.status);

  const json = await res.json();
  const items: unknown[] = Array.isArray(json.value) ? json.value : [];
  return items.flatMap((raw) => {
    const item = raw as {
      id?: string;
      subject?: string;
      bodyPreview?: string;
      location?: { displayName?: string };
      attendees?: Array<{ emailAddress?: { name?: string; address?: string } }>;
      isAllDay?: boolean;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    };
    const startDateOnly = !item.start?.dateTime && !!item.start?.date;
    const endDateOnly = !item.end?.dateTime && !!item.end?.date;
    const startVal = item.start?.dateTime ?? item.start?.date;
    const endVal = item.end?.dateTime ?? item.end?.date;
    if (!item.id || !startVal || !endVal) return [];
    const formatDateTime = (value: string, dateOnly: boolean) => {
      if (dateOnly) return value.includes("T") ? value : `${value}T00:00:00Z`;
      if (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) return value;
      return `${value}Z`;
    };
    return [{
      externalId: item.id,
      title: item.subject || "(No title)",
      start_at: formatDateTime(startVal, startDateOnly),
      end_at: formatDateTime(endVal, endDateOnly),
      description: item.bodyPreview ?? null,
      location: item.location?.displayName ?? null,
      attendees: (item.attendees ?? [])
        .map((attendee) => attendee.emailAddress?.name || attendee.emailAddress?.address)
        .filter((attendee): attendee is string => !!attendee),
      all_day: !!item.isAllDay || startDateOnly,
    }];
  });
}

export async function createOutlookEvent(
  userId: string,
  event: { title: string; start_at: string; end_at: string; description?: string },
): Promise<string | null> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return null;

  const res = await timedProviderFetch(
    BASE,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: event.title,
        body: { contentType: "text", content: event.description ?? "" },
        start: { dateTime: event.start_at, timeZone: "UTC" },
        end: { dateTime: event.end_at, timeZone: "UTC" },
      }),
    },
    { area: "calendar", provider: "outlook", operation: "create_event", timeoutMs: 8_000, slowMs: 2_000 },
  );

  if (!res.ok) throw outlookCalendarError("create_event", res.status);
  const json = await res.json();
  return json.id as string;
}

export async function updateOutlookEvent(
  userId: string,
  outlookEventId: string,
  event: { title: string; start_at: string; end_at: string; description?: string },
): Promise<boolean> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return false;

  const res = await timedProviderFetch(
    `${BASE}/${encodeURIComponent(outlookEventId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: event.title,
        body: { contentType: "text", content: event.description ?? "" },
        start: { dateTime: event.start_at, timeZone: "UTC" },
        end: { dateTime: event.end_at, timeZone: "UTC" },
      }),
    },
    { area: "calendar", provider: "outlook", operation: "update_event", timeoutMs: 8_000, slowMs: 2_000 },
  );

  if (!res.ok && res.status !== 404) throw outlookCalendarError("update_event", res.status);
  return res.ok;
}

export async function deleteOutlookEvent(userId: string, outlookEventId: string): Promise<boolean> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return false;

  const res = await timedProviderFetch(
    `${BASE}/${encodeURIComponent(outlookEventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
    { area: "calendar", provider: "outlook", operation: "delete_event", timeoutMs: 6_000, slowMs: 1_500 },
  );

  if (!res.ok && res.status !== 404) throw outlookCalendarError("delete_event", res.status);
  return res.ok || res.status === 404;
}
