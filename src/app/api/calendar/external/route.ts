import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listGoogleEvents } from "@/lib/calendar/google";
import { listOutlookEvents } from "@/lib/calendar/outlook";

// GET /api/calendar/external?start=ISO&end=ISO
// Pulls the user's actual events from any connected external calendars
// (read-only — these never get written to schedule_events) so connecting
// Google/Outlook surfaces real content instead of just a connected badge.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ events: [] });

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end are required" }, { status: 400 });

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("provider")
    .eq("user_id", user.id);

  const providers = new Set((connections ?? []).map((c) => c.provider));

  const [google, outlook] = await Promise.all([
    providers.has("google") ? listGoogleEvents(user.id, start, end).catch(() => []) : Promise.resolve([]),
    providers.has("outlook") ? listOutlookEvents(user.id, start, end).catch(() => []) : Promise.resolve([]),
  ]);

  const events = [
    ...google.map((e) => ({ ...e, source: "google" as const })),
    ...outlook.map((e) => ({ ...e, source: "outlook" as const })),
  ];

  return NextResponse.json({ events });
}
