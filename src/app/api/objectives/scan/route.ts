import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scanForObjectives } from "@/lib/objectives/scan";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const scan = await scanForObjectives(user.id, supabase);
  return NextResponse.json(scan);
}
