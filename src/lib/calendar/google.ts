import { getFreshAccessToken } from "./tokens";

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type ExternalCalendarEvent = {
  externalId: string;
  title: string;
  start_at: string;
  end_at: string;
  description?: string | null;
  location?: string | null;
  attendees?: string[];
  all_day: boolean;
};

export async function listGoogleEvents(
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<ExternalCalendarEvent[]> {
  const token = await getFreshAccessToken(userId, "google");
  if (!token) return [];

  const url = `${BASE}?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];

  const json = await res.json();
  const items: unknown[] = Array.isArray(json.items) ? json.items : [];
  return items.flatMap((raw) => {
    const item = raw as {
      id?: string;
      summary?: string;
      description?: string;
      location?: string;
      attendees?: Array<{ displayName?: string; email?: string }>;
      status?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    };
    if (!item.id || item.status === "cancelled") return [];
    const allDay = !item.start?.dateTime;
    const start = item.start?.dateTime ?? item.start?.date;
    const end = item.end?.dateTime ?? item.end?.date;
    if (!start || !end) return [];
    return [{
      externalId: item.id,
      title: item.summary || "(No title)",
      start_at: start,
      end_at: end,
      description: item.description ?? null,
      location: item.location ?? null,
      attendees: (item.attendees ?? [])
        .map((attendee) => attendee.displayName || attendee.email)
        .filter((attendee): attendee is string => !!attendee),
      all_day: allDay,
    }];
  });
}

export async function createGoogleEvent(
  userId: string,
  event: { title: string; start_at: string; end_at: string; description?: string },
): Promise<string | null> {
  const token = await getFreshAccessToken(userId, "google");
  if (!token) return null;

  const res = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: event.title,
      description: event.description ?? "",
      start: { dateTime: event.start_at, timeZone: "UTC" },
      end: { dateTime: event.end_at, timeZone: "UTC" },
    }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.id as string;
}

export async function deleteGoogleEvent(userId: string, gcalEventId: string): Promise<boolean> {
  const token = await getFreshAccessToken(userId, "google");
  if (!token) return false;

  const res = await fetch(`${BASE}/${encodeURIComponent(gcalEventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return res.ok || res.status === 404;
}
