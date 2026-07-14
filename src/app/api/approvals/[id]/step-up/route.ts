import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";

/**
 * WebAuthn step-up for a FINANCIAL_EXECUTION / DESTRUCTIVE_ADMIN approval
 * (program §11.2). `approvals.step_up_verified_at` is set ONLY here, after a
 * verified passkey assertion by the approval's owner — never on a client's
 * self-attestation. The execute path (`isActionable`) then requires it.
 *
 * GET  ?action=options → authentication options for the user's registered
 *                        passkeys, with a stored challenge.
 * POST ?action=verify  → verify the assertion; on success stamp step_up_verified_at.
 */

// Challenge table has no RLS (server-managed); use the admin client when present.
function challengeClient(session: Awaited<ReturnType<typeof createClient>>) {
  return createAdminClient() ?? session;
}

async function loadApproval(
  session: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  id: string,
) {
  const { data } = await session
    .from("approvals")
    .select("id, requirement, status, step_up_verified_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  return data;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (req.nextUrl.searchParams.get("action") !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const approval = await loadApproval(supabase, user.id, id);
  if (!approval) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (approval.requirement !== "approval_step_up") {
    return NextResponse.json({ error: "STEP_UP_NOT_REQUIRED" }, { status: 400 });
  }
  if (approval.status !== "pending" && approval.status !== "approved") {
    return NextResponse.json({ error: "NOT_STEP_UP_ELIGIBLE", status: approval.status }, { status: 409 });
  }

  const { data: passkeys } = await supabase
    .from("user_passkeys")
    .select("credential_id")
    .eq("user_id", user.id);
  const credentialIds = (passkeys ?? []).map((p) => p.credential_id);
  if (credentialIds.length === 0) {
    return NextResponse.json({ error: "NO_PASSKEY" }, { status: 400 });
  }

  const options = await buildAuthenticationOptions(credentialIds);
  const db = challengeClient(supabase);
  await db.from("webauthn_challenges").delete().eq("type", "authentication").eq("user_id", user.id).lt("expires_at", new Date().toISOString());
  const { error } = await db.from("webauthn_challenges").insert({
    challenge: options.challenge,
    type: "authentication",
    user_id: user.id,
    approval_id: id, // bind the assertion to THIS approval (defense-in-depth)
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  if (error) return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });

  return NextResponse.json(options);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (req.nextUrl.searchParams.get("action") !== "verify") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  // Throttle assertion attempts per user (brute-force / abuse guard), matching
  // the login passkey route.
  const { success } =
    (await redisRateLimit(user.id, 10, "10 m", "axis:approval-step-up")) ??
    memoryRateLimit(`approval-step-up:${user.id}`, 10, 10 * 60_000);
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { response?: AuthenticationResponseJSON } | null;
  const response = body?.response;
  if (!response) return NextResponse.json({ error: "MISSING_RESPONSE" }, { status: 400 });

  const approval = await loadApproval(supabase, user.id, id);
  if (!approval) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (approval.requirement !== "approval_step_up") {
    return NextResponse.json({ error: "STEP_UP_NOT_REQUIRED" }, { status: 400 });
  }

  // The credential MUST belong to this user (never accept another user's passkey).
  const { data: passkey } = await supabase
    .from("user_passkeys")
    .select("id, credential_id, credential_public_key, counter, transports")
    .eq("user_id", user.id)
    .eq("credential_id", response.id)
    .maybeSingle();
  if (!passkey) return NextResponse.json({ error: "PASSKEY_NOT_FOUND" }, { status: 404 });

  const db = challengeClient(supabase);
  const { data: challenges } = await db
    .from("webauthn_challenges")
    .select("id, challenge")
    .eq("type", "authentication")
    .eq("user_id", user.id)
    .eq("approval_id", id) // must be a challenge minted for THIS approval
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const challengeRow = challenges?.[0];
  if (!challengeRow) return NextResponse.json({ error: "CHALLENGE_EXPIRED" }, { status: 400 });
  await db.from("webauthn_challenges").delete().eq("id", challengeRow.id); // one-time use

  let verified;
  try {
    verified = await verifyAuthentication(response, challengeRow.challenge, {
      credentialId: passkey.credential_id,
      credentialPublicKey: passkey.credential_public_key,
      counter: passkey.counter,
      transports: passkey.transports ?? [],
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "VERIFY_FAILED" }, { status: 400 });
  }
  if (!verified.verified) return NextResponse.json({ error: "NOT_VERIFIED" }, { status: 400 });

  await supabase
    .from("user_passkeys")
    .update({ counter: verified.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq("id", passkey.id);

  // Stamp step-up on the approval — scoped to owner + step-up class + eligible status.
  const { data: updated, error: updateError } = await supabase
    .from("approvals")
    .update({ step_up_verified_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("id", id)
    .eq("requirement", "approval_step_up")
    .in("status", ["pending", "approved"])
    .select("id, step_up_verified_at")
    .maybeSingle();
  if (updateError || !updated) return NextResponse.json({ error: "STEP_UP_UPDATE_FAILED" }, { status: 500 });

  return NextResponse.json({ verified: true, stepUpVerifiedAt: updated.step_up_verified_at });
}
