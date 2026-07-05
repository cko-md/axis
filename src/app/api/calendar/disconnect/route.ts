import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { deleteTokens, type CalendarProvider } from "@/lib/calendar/tokens";

// DELETE /api/calendar/disconnect?provider=google|outlook
export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") as CalendarProvider | null;
  if (provider !== "google" && provider !== "outlook") {
    return NextResponse.json({ error: "provider must be google or outlook" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const error = await deleteTokens(user.id, provider);
  if (error) {
    Sentry.captureException(error, {
      tags: { area: "calendar", operation: "disconnect", provider, transport: "direct" },
    });
    return NextResponse.json({ error: "Could not disconnect calendar" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
