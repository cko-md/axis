import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupportedToolkit } from "@/lib/integrations/composio";

// Disconnect revokes a third-party grant. Keep it deliberately disabled until
// the durable mutation kernel owns an exact connection-id tombstone/retry
// lifecycle; the previous endpoint deleted every raw account for a toolkit.
export async function DELETE(req: NextRequest) {
  const toolkit = req.nextUrl.searchParams.get("toolkit");
  if (!toolkit) return NextResponse.json({ error: "toolkit param is required" }, { status: 400 });
  if (!isSupportedToolkit(toolkit)) return NextResponse.json({ error: "Unsupported toolkit" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  return NextResponse.json(
    { error: "Provider disconnect is temporarily unavailable while connection authority is upgraded.", code: "mutation_kernel_required" },
    { status: 503 },
  );
}
