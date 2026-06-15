import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createGoogleEvent } from "@/lib/calendar/google";
import { createOutlookEvent } from "@/lib/calendar/outlook";

// POST /api/calendar/sync
// Creates the given schedule_event in all connected calendars and
// writes the external IDs back to the schedule_events row.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { eventId?: unknown; title?: unknown; start_at?: unknown; end_at?: unknown; description?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { eventId, title, start_at, end_at, description } = body;
  if (typeof eventId !== "string" || typeof title !== "string" || typeof start_at !== "string" || typeof end_at !== "string") {
    return NextResponse.json({ error: "eventId, title, start_at, end_at are required" }, { status: 400 });
  }

  const event = { title, start_at, end_at, description: typeof description === "string" ? description : undefined };

  const [gcalId, outlookId] = await Promise.all([
    createGoogleEvent(user.id, event).catch(() => null),
    createOutlookEvent(user.id, event).catch(() => null),
  ]);

  // Write IDs back — only update columns where sync succeeded
  const patch: Record<string, string> = {};
  if (gcalId) patch.gcal_event_id = gcalId;
  if (outlookId) patch.outlook_event_id = outlookId;

  if (Object.keys(patch).length) {
    await supabase.from("schedule_events").update(patch).eq("id", eventId).eq("user_id", user.id);
  }

  return NextResponse.json({ gcalId, outlookId });
}
