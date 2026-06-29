import { getFreshAccessToken } from "./tokens";
import type { ExternalCalendarEvent } from "./google";

const BASE = "https://graph.microsoft.com/v1.0/me/events";
const VIEW_BASE = "https://graph.microsoft.com/v1.0/me/calendarView";

export async function listOutlookEvents(
  userId: string,
  startDateTime: string,
  endDateTime: string,
): Promise<ExternalCalendarEvent[]> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return [];

  const url = `${VIEW_BASE}?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$orderby=start/dateTime`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) return [];

  const json = await res.json();
  const items: unknown[] = Array.isArray(json.value) ? json.value : [];
  return items.flatMap((raw) => {
    const item = raw as {
      id?: string;
      subject?: string;
      bodyPreview?: string;
      isAllDay?: boolean;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    };
    if (!item.id || !item.start?.dateTime || !item.end?.dateTime) return [];
    return [{
      externalId: item.id,
      title: item.subject || "(No title)",
      start_at: `${item.start.dateTime}Z`,
      end_at: `${item.end.dateTime}Z`,
      description: item.bodyPreview ?? null,
      all_day: !!item.isAllDay,
    }];
  });
}

export async function createOutlookEvent(
  userId: string,
  event: { title: string; start_at: string; end_at: string; description?: string },
): Promise<string | null> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return null;

  const res = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: event.title,
      body: { contentType: "text", content: event.description ?? "" },
      start: { dateTime: event.start_at, timeZone: "UTC" },
      end: { dateTime: event.end_at, timeZone: "UTC" },
    }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.id as string;
}

export async function deleteOutlookEvent(userId: string, outlookEventId: string): Promise<boolean> {
  const token = await getFreshAccessToken(userId, "outlook");
  if (!token) return false;

  const res = await fetch(`${BASE}/${encodeURIComponent(outlookEventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return res.ok || res.status === 404;
}
