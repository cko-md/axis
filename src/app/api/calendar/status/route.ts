import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ google: false, outlook: false });

  const { data } = await supabase
    .from("calendar_connections")
    .select("provider, calendar_email")
    .eq("user_id", user.id);

  const rows = data ?? [];
  const google = rows.find((r) => r.provider === "google");
  const outlook = rows.find((r) => r.provider === "outlook");

  return NextResponse.json({
    google: !!google,
    googleEmail: google?.calendar_email ?? null,
    outlook: !!outlook,
    outlookEmail: outlook?.calendar_email ?? null,
  });
}
