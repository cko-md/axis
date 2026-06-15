import { getFreshAccessToken } from "./tokens";

const BASE = "https://graph.microsoft.com/v1.0/me/events";

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
