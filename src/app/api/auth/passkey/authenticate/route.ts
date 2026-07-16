import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";
import { decrypt } from "@/lib/crypto";
import { optionalEnv } from "@/lib/env";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const email = req.nextUrl.searchParams.get("email") ?? undefined;

  // Pre-auth flow: no session exists, so RLS on user_passkeys/webauthn_challenges
  // would block these reads/writes. Use the service-role client when configured;
  // fall back to the anon client until SUPABASE_SERVICE_ROLE_KEY is set.
  const supabase = createAdminClient() ?? (await createClient());

  // Clean up stale authentication challenges before creating a new one
  await supabase
    .from("webauthn_challenges")
    .delete()
    .eq("type", "authentication")
    .lt("expires_at", new Date().toISOString());

  // Discoverable credential flow — empty allowCredentials lets any resident key respond
  const options = await buildAuthenticationOptions([]);

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { error: challengeError } = await supabase.from("webauthn_challenges").insert({
    challenge: options.challenge,
    type: "authentication",
    ...(email ? { email } : {}),
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

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anonymous";
  const { success } =
    (await redisRateLimit(ip, 10, "10 m", "axis:passkey-verify", { failClosed: true })) ??
    memoryRateLimit(`passkey-verify:${ip}`, 10, 10 * 60_000);
  if (!success) {
    return NextResponse.json({ error: "Too many attempts. Please wait before trying again." }, { status: 429 });
  }

  if (!optionalEnv("PASSKEY_ENCRYPTION_KEY")) {
    console.warn("[passkey] PASSKEY_ENCRYPTION_KEY not set — refresh token decryption unavailable");
  }

  let body: { response: AuthenticationResponseJSON; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { response } = body;
  if (!response) {
    return NextResponse.json({ error: "Missing response" }, { status: 400 });
  }

  // Pre-auth flow: no session exists, so RLS on user_passkeys/webauthn_challenges
  // would block these reads/writes. Use the service-role client when configured;
  // fall back to the anon client until SUPABASE_SERVICE_ROLE_KEY is set.
  const supabase = createAdminClient() ?? (await createClient());

  // Decode userHandle from the assertion response to get userId
  const userHandleB64 = response.response.userHandle;
  let userId: string | null = null;
  if (userHandleB64) {
    try {
      userId = Buffer.from(userHandleB64, "base64url").toString("utf8");
    } catch {
      // Will still look up by credential_id below
    }
  }

  // Look up the passkey by credential_id (response.id is the credential ID)
  const { data: passkey, error: passkeyError } = await supabase
    .from("user_passkeys")
    .select(
      "id, user_id, credential_id, credential_public_key, counter, transports, refresh_token_enc",
    )
    .eq("credential_id", response.id)
    .single();

  if (passkeyError || !passkey) {
    return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
  }

  // Reconcile userId: prefer the decoded userHandle, fall back to passkey.user_id
  const resolvedUserId: string = userId ?? passkey.user_id;

  // Sanity check: decoded userId must match the passkey's owner
  if (userId && userId !== passkey.user_id) {
    return NextResponse.json({ error: "Credential mismatch" }, { status: 400 });
  }

  // Fetch the matching challenge (unbound to user_id since they may not be logged in)
  const now = new Date().toISOString();
  const { data: challenges } = await supabase
    .from("webauthn_challenges")
    .select("id, challenge")
    .eq("type", "authentication")
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(1);

  const challengeRow = challenges?.[0];
  if (!challengeRow) {
    return NextResponse.json({ error: "Challenge not found or expired" }, { status: 400 });
  }

  // Delete challenge immediately (one-time use)
  await supabase.from("webauthn_challenges").delete().eq("id", challengeRow.id);

  let verified: Awaited<ReturnType<typeof verifyAuthentication>>;
  try {
    verified = await verifyAuthentication(response, challengeRow.challenge, {
      credentialId: passkey.credential_id,
      credentialPublicKey: passkey.credential_public_key,
      counter: passkey.counter,
      transports: passkey.transports ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!verified.verified) {
    return NextResponse.json({ error: "Authentication not verified" }, { status: 400 });
  }

  // Update counter and last_used_at
  await supabase
    .from("user_passkeys")
    .update({
      counter: verified.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", passkey.id);

  // Optionally return a decrypted refresh token so the client can restore Supabase session
  let refreshToken: string | undefined;
  if (passkey.refresh_token_enc) {
    const decrypted = decrypt(passkey.refresh_token_enc);
    if (decrypted) refreshToken = decrypted;
  }

  return NextResponse.json({
    verified: true,
    userId: resolvedUserId,
    ...(refreshToken ? { refreshToken } : {}),
  });
}
