import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { emitServerEvent } from "@/lib/observability/events";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const ROUTE = "approvals.step-up";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function loadApproval(
  session: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  id: string,
) {
  return session
    .from("approvals")
    .select("id, requirement, status, step_up_verified_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
}

async function checkRateLimit(
  userId: string,
  limit: number,
  prefix: string,
) {
  return (
    (await redisRateLimit(userId, limit, "10 m", prefix)) ??
    memoryRateLimit(`${prefix}:${userId}`, limit, 10 * 60_000)
  );
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (req.nextUrl.searchParams.get("action") !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const { success } = await checkRateLimit(
    user.id,
    20,
    "axis:approval-step-up-options",
  );
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  const { data: approval, error: approvalError } = await loadApproval(supabase, user.id, id);
  if (approvalError) {
    captureRouteError(approvalError, {
      route: ROUTE,
      operation: "read_approval_options",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UNAVAILABLE",
    });
    return NextResponse.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 500 });
  }
  if (!approval) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (approval.requirement !== "approval_step_up") {
    return NextResponse.json({ error: "STEP_UP_NOT_REQUIRED" }, { status: 400 });
  }
  if (approval.status !== "pending" && approval.status !== "approved") {
    return NextResponse.json(
      {
        error: approval.status === "executing" ? "APPROVAL_IN_FLIGHT" : "NOT_STEP_UP_ELIGIBLE",
        status: approval.status,
      },
      { status: 409 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "APPROVAL_WRITE_UNAVAILABLE",
        message: "Approval writes are temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  const { data: passkeys, error: passkeysError } = await admin
    .from("user_passkeys")
    .select("credential_id")
    .eq("user_id", user.id);
  if (passkeysError) {
    captureRouteError(passkeysError, {
      route: ROUTE,
      operation: "list_passkeys",
      area: "auth",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEYS_UNAVAILABLE" }, { status: 500 });
  }
  const credentialIds = (passkeys ?? []).map((p) => p.credential_id);
  if (credentialIds.length === 0) {
    return NextResponse.json({ error: "NO_PASSKEY" }, { status: 400 });
  }

  const options = await buildAuthenticationOptions(credentialIds);
  const { error: cleanupError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("type", "authentication")
    .eq("user_id", user.id)
    .lt("expires_at", new Date().toISOString());
  if (cleanupError) {
    captureRouteError(cleanupError, {
      route: ROUTE,
      operation: "cleanup_challenges",
      area: "auth",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }
  const { data: storedChallenge, error } = await admin
    .from("webauthn_challenges")
    .insert({
      challenge: options.challenge,
      type: "authentication",
      user_id: user.id,
      approval_id: id, // bind the assertion to THIS approval (defense-in-depth)
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !storedChallenge) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "store_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }

  return NextResponse.json({ options, ceremonyId: storedChallenge.id });
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
  const { success } = await checkRateLimit(
    user.id,
    10,
    "axis:approval-step-up-verify",
  );
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    response?: AuthenticationResponseJSON;
    ceremonyId?: string;
  } | null;
  const response = body?.response;
  if (!response) return NextResponse.json({ error: "MISSING_RESPONSE" }, { status: 400 });
  if (!body?.ceremonyId || !UUID_PATTERN.test(body.ceremonyId)) {
    return NextResponse.json({ error: "INVALID_CEREMONY_ID" }, { status: 400 });
  }
  const ceremonyId = body.ceremonyId;

  const { data: approval, error: approvalError } = await loadApproval(supabase, user.id, id);
  if (approvalError) {
    captureRouteError(approvalError, {
      route: ROUTE,
      operation: "read_approval_verify",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UNAVAILABLE",
    });
    return NextResponse.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 500 });
  }
  if (!approval) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (approval.requirement !== "approval_step_up") {
    return NextResponse.json({ error: "STEP_UP_NOT_REQUIRED" }, { status: 400 });
  }
  if (approval.status !== "pending" && approval.status !== "approved") {
    return NextResponse.json(
      {
        error: approval.status === "executing" ? "APPROVAL_IN_FLIGHT" : "NOT_STEP_UP_ELIGIBLE",
        status: approval.status,
      },
      { status: 409 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "APPROVAL_WRITE_UNAVAILABLE",
        message: "Approval writes are temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  // The credential MUST belong to this user (never accept another user's passkey).
  const { data: passkey, error: passkeyError } = await admin
    .from("user_passkeys")
    .select("id, credential_id, credential_public_key, counter, transports")
    .eq("user_id", user.id)
    .eq("credential_id", response.id)
    .maybeSingle();
  if (passkeyError) {
    captureRouteError(passkeyError, {
      route: ROUTE,
      operation: "read_passkey",
      area: "auth",
      status: 500,
      code: "PASSKEY_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_UNAVAILABLE" }, { status: 500 });
  }
  if (!passkey) return NextResponse.json({ error: "PASSKEY_NOT_FOUND" }, { status: 404 });

  const { data: challengeRow, error: challengeError } = await admin
    .from("webauthn_challenges")
    .select("id, challenge")
    .eq("id", ceremonyId)
    .eq("type", "authentication")
    .eq("user_id", user.id)
    .eq("approval_id", id) // must be a challenge minted for THIS approval
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (challengeError) {
    captureRouteError(challengeError, {
      route: ROUTE,
      operation: "read_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_UNAVAILABLE",
    });
    return NextResponse.json({ error: "CHALLENGE_UNAVAILABLE" }, { status: 500 });
  }
  if (!challengeRow) return NextResponse.json({ error: "CHALLENGE_EXPIRED" }, { status: 400 });
  const { data: consumedChallenge, error: consumeError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("id", ceremonyId)
    .eq("type", "authentication")
    .eq("user_id", user.id)
    .eq("approval_id", id)
    .select("id")
    .maybeSingle();
  if (consumeError) {
    captureRouteError(consumeError, {
      route: ROUTE,
      operation: "consume_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_CONSUME_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_CONSUME_FAILED" }, { status: 500 });
  }
  if (!consumedChallenge) {
    return NextResponse.json({ error: "CHALLENGE_ALREADY_USED" }, { status: 409 });
  }

  let verified;
  try {
    verified = await verifyAuthentication(response, challengeRow.challenge, {
      credentialId: passkey.credential_id,
      credentialPublicKey: passkey.credential_public_key,
      counter: passkey.counter,
      transports: passkey.transports ?? [],
    });
  } catch {
    return NextResponse.json({ error: "VERIFY_FAILED" }, { status: 400 });
  }
  if (!verified.verified) return NextResponse.json({ error: "NOT_VERIFIED" }, { status: 400 });

  const { data: updatedPasskey, error: counterError } = await admin
    .from("user_passkeys")
    .update({ counter: verified.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("id", passkey.id)
    .eq("counter", passkey.counter)
    .select("id")
    .maybeSingle();
  if (counterError) {
    captureRouteError(counterError, {
      route: ROUTE,
      operation: "update_passkey_counter",
      area: "auth",
      status: 500,
      code: "PASSKEY_COUNTER_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_COUNTER_UPDATE_FAILED" }, { status: 500 });
  }
  if (!updatedPasskey) {
    return NextResponse.json({ error: "PASSKEY_COUNTER_CONFLICT" }, { status: 409 });
  }

  // Stamp step-up on the approval — scoped to owner + step-up class + eligible status.
  const { data: updated, error: updateError } = await admin
    .from("approvals")
    .update({ step_up_verified_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("id", id)
    .eq("requirement", "approval_step_up")
    .in("status", ["pending", "approved"])
    .select("id, step_up_verified_at")
    .maybeSingle();
  if (updateError) {
    captureRouteError(updateError, {
      route: ROUTE,
      operation: "stamp_approval",
      area: "approvals",
      status: 500,
      code: "STEP_UP_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "STEP_UP_UPDATE_FAILED" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "STALE_APPROVAL", expected: ["pending", "approved"] },
      { status: 409 },
    );
  }

  emitServerEvent("approval.step_up_verified", { approvalId: updated.id });

  return NextResponse.json({ verified: true, stepUpVerifiedAt: updated.step_up_verified_at });
}
