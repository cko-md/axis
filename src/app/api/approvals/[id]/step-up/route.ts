import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { emitServerEvent } from "@/lib/observability/events";
import {
  commitApprovalStepUp,
  consumeApprovalAuthenticationChallenge,
} from "@/lib/security/approvalMutations";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (req.nextUrl.searchParams.get("action") !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const { success } =
    (await redisRateLimit(user.id, 20, "10 m", "axis:approval-step-up-options")) ??
    memoryRateLimit(`approval-step-up-options:${user.id}`, 20, 10 * 60_000);
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  const { data: approval, error: approvalError } = await loadApproval(supabase, user.id, id);
  if (approvalError) {
    captureRouteError(new Error("Approval step-up lookup failed"), {
      route: "approval_step_up",
      operation: "load_approval",
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
    return NextResponse.json({ error: "NOT_STEP_UP_ELIGIBLE", status: approval.status }, { status: 409 });
  }

  const { data: passkeys, error: passkeysError } = await supabase
    .from("user_passkeys")
    .select("credential_id")
    .eq("user_id", user.id);
  if (passkeysError) {
    captureRouteError(new Error("Approval passkey lookup failed"), {
      route: "approval_step_up",
      operation: "load_passkeys",
      area: "approvals",
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
  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Approval step-up service role unavailable"), {
      route: "approval_step_up",
      operation: "options",
      area: "approvals",
      status: 503,
      code: "STEP_UP_UNAVAILABLE",
    });
    return NextResponse.json({ error: "STEP_UP_UNAVAILABLE" }, { status: 503 });
  }
  const now = new Date().toISOString();
  const { error: cleanupError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("type", "authentication")
    .eq("user_id", user.id)
    .lt("expires_at", now);
  if (cleanupError) {
    captureRouteError(new Error("Approval challenge cleanup failed"), {
      route: "approval_step_up",
      operation: "challenge_cleanup",
      area: "approvals",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }
  const { data: challengeRow, error } = await admin
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
  if (error || !challengeRow) {
    captureRouteError(new Error("Approval challenge insert failed"), {
      route: "approval_step_up",
      operation: "challenge_insert",
      area: "approvals",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }

  return NextResponse.json({ options, challengeId: challengeRow.id });
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

  const body = (await req.json().catch(() => null)) as {
    response?: AuthenticationResponseJSON;
    challengeId?: unknown;
  } | null;
  const response = body?.response;
  if (!response) return NextResponse.json({ error: "MISSING_RESPONSE" }, { status: 400 });
  if (typeof body.challengeId !== "string" || !UUID_RE.test(body.challengeId)) {
    return NextResponse.json({ error: "MISSING_CHALLENGE_ID" }, { status: 400 });
  }

  const { data: approval, error: approvalError } = await loadApproval(supabase, user.id, id);
  if (approvalError) {
    captureRouteError(new Error("Approval step-up lookup failed"), {
      route: "approval_step_up",
      operation: "load_approval",
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
    return NextResponse.json({ error: "NOT_STEP_UP_ELIGIBLE", status: approval.status }, { status: 409 });
  }

  // The credential MUST belong to this user (never accept another user's passkey).
  const { data: passkey, error: passkeyError } = await supabase
    .from("user_passkeys")
    .select("id, credential_id, credential_public_key, counter, transports")
    .eq("user_id", user.id)
    .eq("credential_id", response.id)
    .maybeSingle();
  if (passkeyError) {
    captureRouteError(new Error("Approval passkey lookup failed"), {
      route: "approval_step_up",
      operation: "load_passkey",
      area: "approvals",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEYS_UNAVAILABLE" }, { status: 500 });
  }
  if (!passkey) return NextResponse.json({ error: "PASSKEY_NOT_FOUND" }, { status: 404 });

  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Approval step-up service role unavailable"), {
      route: "approval_step_up",
      operation: "verify",
      area: "approvals",
      status: 503,
      code: "STEP_UP_UNAVAILABLE",
    });
    return NextResponse.json({ error: "STEP_UP_UNAVAILABLE" }, { status: 503 });
  }
  const consumedChallenge = await consumeApprovalAuthenticationChallenge({
    userId: user.id,
    approvalId: id,
    challengeId: body.challengeId,
    now: new Date().toISOString(),
  }, admin);
  if (!consumedChallenge.ok) {
    if (consumedChallenge.code === "NOT_FOUND") {
      return NextResponse.json({ error: "CHALLENGE_EXPIRED" }, { status: 400 });
    }
    captureRouteError(new Error("Approval challenge consume failed"), {
      route: "approval_step_up",
      operation: "challenge_consume",
      area: "approvals",
      status: consumedChallenge.code === "SERVICE_UNAVAILABLE" ? 503 : 500,
      code: "CHALLENGE_CONSUME_FAILED",
    });
    return NextResponse.json(
      { error: "CHALLENGE_CONSUME_FAILED" },
      { status: consumedChallenge.code === "SERVICE_UNAVAILABLE" ? 503 : 500 },
    );
  }

  let verified;
  try {
    verified = await verifyAuthentication(response, consumedChallenge.challenge, {
      credentialId: passkey.credential_id,
      credentialPublicKey: passkey.credential_public_key,
      counter: passkey.counter,
      transports: passkey.transports ?? [],
    });
  } catch {
    return NextResponse.json({ error: "VERIFY_FAILED" }, { status: 400 });
  }
  if (!verified.verified) return NextResponse.json({ error: "NOT_VERIFIED" }, { status: 400 });

  const verifiedAt = new Date().toISOString();
  const result = await commitApprovalStepUp({
    userId: user.id,
    approvalId: id,
    expectedApprovalStatus: approval.status,
    passkeyId: passkey.id,
    expectedCounter: passkey.counter,
    newCounter: verified.authenticationInfo.newCounter,
    verifiedAt,
  }, admin);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (result.code === "APPROVAL_CONFLICT") {
      return NextResponse.json(
        { error: "STALE_APPROVAL_STATE", currentStatus: result.currentStatus },
        { status: 409 },
      );
    }
    if (result.code === "PASSKEY_NOT_FOUND") {
      return NextResponse.json({ error: "PASSKEY_NOT_FOUND" }, { status: 404 });
    }
    if (result.code === "COUNTER_CONFLICT") {
      return NextResponse.json({ error: "PASSKEY_COUNTER_CONFLICT" }, { status: 409 });
    }
    captureRouteError(new Error("Approval step-up update failed"), {
      route: "approval_step_up",
      operation: "stamp",
      area: "approvals",
      status: 500,
      code: "STEP_UP_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "STEP_UP_UPDATE_FAILED" }, { status: 500 });
  }
  const updated = result.approval;

  emitServerEvent("approval.step_up_verified", { approvalId: updated.id });

  return NextResponse.json({ verified: true, stepUpVerifiedAt: updated.step_up_verified_at });
}
