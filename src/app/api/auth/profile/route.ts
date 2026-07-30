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

function isMissingSession(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown; status?: unknown };
  return value.status === 401 || value.code === "refresh_token_not_found" || value.code === "invalid_refresh_token"
    || value.message === "Auth session missing!";
}

function identityResponse(user: unknown, error: unknown, operation: string) {
  if (!user || isMissingSession(error)) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (error) return unavailable(operation);
  return null;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    const identityFailure = identityResponse(user, authError, "read_identity");
    if (identityFailure) return identityFailure;
    if (!user) return unavailable("read_identity_unexpected");
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
    const contentType = request.headers.get("content-type")?.split(";", 1)[0];
    const origin = request.headers.get("origin");
    if (contentType !== "application/json" || (origin !== null && origin !== new URL(request.url).origin)) {
      return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(contentLength) || contentLength > 10_000) return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    const identityFailure = identityResponse(user, authError, "write_identity");
    if (identityFailure) return identityFailure;
    if (!user) return unavailable("write_identity_unexpected");
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== PROFILE_KEYS.length || !PROFILE_KEYS.every((key) => typeof record[key] === "string" && record[key].length <= MAX_PROFILE_FIELD_LENGTH)) {
      return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }
    const profile = record as Record<(typeof PROFILE_KEYS)[number], string>;
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
