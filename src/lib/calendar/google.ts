import { getFreshAccessToken } from "./tokens";

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

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
