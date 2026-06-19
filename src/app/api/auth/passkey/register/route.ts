import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRegistrationOptions, verifyRegistration } from "@/lib/webauthn/server";

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Fetch existing credential IDs to exclude from options (prevent re-registering same device)
  const { data: existing } = await supabase
    .from("user_passkeys")
    .select("credential_id")
    .eq("user_id", user.id);

  const existingIds = (existing ?? []).map((row) => row.credential_id as string);

  const options = await buildRegistrationOptions(user.id, user.email ?? "", existingIds);

  // webauthn_challenges is service-role-only (RLS on, no policies). Use the
  // admin client when configured; fall back to the anon client otherwise.
  const admin = createAdminClient() ?? supabase;

  // Store challenge — delete any stale registration challenges for this user first
  await admin
    .from("webauthn_challenges")
    .delete()
    .eq("user_id", user.id)
    .eq("type", "registration");

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { error: challengeError } = await admin.from("webauthn_challenges").insert({
    challenge: options.challenge,
    type: "registration",
    user_id: user.id,
    email: user.email,
    expires_at: expiresAt,
  });

  if (challengeError) {
    return NextResponse.json({ error: "Failed to store challenge" }, { status: 500 });
  }

  return NextResponse.json(options);
}

// ── POST ?action=verify ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "verify") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { response: RegistrationResponseJSON; deviceName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { response, deviceName } = body;
  if (!response) {
    return NextResponse.json({ error: "Missing response" }, { status: 400 });
  }

  // webauthn_challenges is service-role-only (RLS on, no policies). Use the
  // admin client when configured; fall back to the anon client otherwise.
  const admin = createAdminClient() ?? supabase;

  // Fetch and immediately delete challenge (one-time use)
  const now = new Date().toISOString();
  const { data: challenges } = await admin
    .from("webauthn_challenges")
    .select("id, challenge")
    .eq("user_id", user.id)
    .eq("type", "registration")
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(1);

  const challengeRow = challenges?.[0];
  if (!challengeRow) {
    return NextResponse.json({ error: "Challenge not found or expired" }, { status: 400 });
  }

  // Delete before verifying so it can't be replayed even on error
  await admin.from("webauthn_challenges").delete().eq("id", challengeRow.id);

  let verified: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    verified = await verifyRegistration(response, challengeRow.challenge);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!verified.verified || !verified.registrationInfo) {
    return NextResponse.json({ error: "Registration not verified" }, { status: 400 });
  }

  const { registrationInfo } = verified;
  const publicKeyBase64 = Buffer.from(registrationInfo.credential.publicKey).toString("base64url");

  const { data: inserted, error: insertError } = await supabase
    .from("user_passkeys")
    .insert({
      user_id: user.id,
      credential_id: registrationInfo.credential.id,
      credential_public_key: publicKeyBase64,
      counter: registrationInfo.credential.counter,
      device_type: registrationInfo.credentialDeviceType,
      backed_up: registrationInfo.credentialBackedUp,
      transports: response.response.transports ?? [],
      name: deviceName?.trim() || "My device",
    })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Mark passkey as enabled in user auth settings
  await supabase.from("user_auth_settings").upsert(
    {
      user_id: user.id,
      passkey_enabled: true,
      biometric_prompted: true,
    },
    { onConflict: "user_id" },
  );

  return NextResponse.json({ verified: true, passkeyId: inserted.id });
}
