import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteGoogleEvent } from "@/lib/calendar/google";
import { deleteOutlookEvent } from "@/lib/calendar/outlook";

// DELETE /api/calendar/event/[id]
// Removes the schedule_event from all connected external calendars.
// The local Supabase row deletion is handled by the client separately.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Look up external IDs
  const { data: row } = await supabase
    .from("schedule_events")
    .select("gcal_event_id, outlook_event_id")
    .eq("id", eventId)
    .eq("user_id", user.id)
    .single();

  if (!row) return NextResponse.json({ ok: true }); // already gone

  await Promise.all([
    row.gcal_event_id ? deleteGoogleEvent(user.id, row.gcal_event_id).catch(() => false) : Promise.resolve(),
    row.outlook_event_id ? deleteOutlookEvent(user.id, row.outlook_event_id).catch(() => false) : Promise.resolve(),
  ]);

  return NextResponse.json({ ok: true });
}
