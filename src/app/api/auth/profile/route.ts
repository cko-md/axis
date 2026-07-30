import { NextResponse } from "next/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

const ROUTE = "/api/auth/profile";

type ProfilePayload = {
  display_name: string | null;
  role_title: string | null;
  bio: string | null;
  avatar_url: string | null;
  email: string | null;
};

const PROFILE_KEYS = ["name", "role", "bio", "photo"] as const;
const MAX_PROFILE_FIELD_LENGTH = 2_000;

function unavailable(operation: string) {
  captureRouteError(new Error("Profile account operation failed"), {
    route: ROUTE, area: "auth", operation, status: 500, code: "PROFILE_ACCOUNT_UNAVAILABLE",
  });
  return NextResponse.json({ error: "PROFILE_ACCOUNT_UNAVAILABLE" }, { status: 500 });
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError) return unavailable("read_identity");
    if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    const { data, error } = await supabase.from("profiles")
      .select("display_name, role_title, bio, avatar_url")
      .eq("id", user.id).maybeSingle();
    if (error) return unavailable("read_profile");
    const payload: ProfilePayload = {
      display_name: data?.display_name ?? null, role_title: data?.role_title ?? null,
      bio: data?.bio ?? null, avatar_url: data?.avatar_url ?? null, email: user.email ?? null,
    };
    return NextResponse.json(payload);
  } catch {
    return unavailable("read_unexpected");
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError) return unavailable("write_identity");
    if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 }); }
    if (Object.keys(body).length !== PROFILE_KEYS.length || !PROFILE_KEYS.every((key) => typeof body[key] === "string" && body[key].length <= MAX_PROFILE_FIELD_LENGTH)) {
      return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }
    const profile = body as Record<(typeof PROFILE_KEYS)[number], string>;
    const { error } = await supabase.from("profiles").upsert({
      id: user.id, display_name: profile.name.trim(), role_title: profile.role.trim(), bio: profile.bio.trim(),
      avatar_url: profile.photo.trim(), updated_at: new Date().toISOString(),
    });
    if (error) return unavailable("write_profile");
    return NextResponse.json({ ok: true });
  } catch {
    return unavailable("write_unexpected");
  }
}
