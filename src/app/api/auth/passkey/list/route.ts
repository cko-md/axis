import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";

// ── GET — list passkeys for the current user ──────────────────────────────────

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_passkeys")
    .select("id, name, device_type, backed_up, created_at, last_used_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    captureRouteError(new Error("Passkey list failed"), {
      route: "passkey_list",
      operation: "list_passkeys",
      area: "auth",
      status: 500,
      code: "PASSKEY_LIST_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_LIST_FAILED" }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
