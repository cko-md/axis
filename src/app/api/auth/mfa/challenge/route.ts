import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { requireAuthenticatorAssurance } from "@/lib/auth/authenticatorAssurance";
import { readBoundedJson } from "@/lib/http/boundedJson";
import { authProviderFailureStatus } from "@/lib/auth/providerError";
import { redactRouteError } from "@/lib/observability/redactRouteError";

const MAX_MFA_BODY_BYTES = 8_192;
const MAX_FACTOR_ID_CHARS = 1_024;

// POST /api/auth/mfa/challenge is the sole browser-facing challenge ceremony.
// The server selects a verified factor; a client cannot nominate an arbitrary
// factor or bypass admission controls by calling the Supabase SDK directly.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const admission = await admit(user.id, ADMISSION_POLICIES.mfaChallenge);
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });
  }

  const parsedBody = await readBoundedJson(req, MAX_MFA_BODY_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  const body = parsedBody.value as { factorId?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  if (
    body.factorId !== undefined
    && (typeof body.factorId !== "string" || body.factorId.length === 0 || body.factorId.length > MAX_FACTOR_ID_CHARS)
  ) {
    return NextResponse.json({ error: "INVALID_MFA_FACTOR" }, { status: 400 });
  }
  let assurance;
  try {
    assurance = await requireAuthenticatorAssurance(supabase);
  } catch {
    return NextResponse.json({ error: "AUTH_ASSURANCE_UNAVAILABLE" }, { status: 503 });
  }
  if (assurance === "unavailable") return NextResponse.json({ error: "AUTH_ASSURANCE_UNAVAILABLE" }, { status: 503 });
  let factorsResult;
  try {
    factorsResult = await supabase.auth.mfa.listFactors();
  } catch {
    return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  }
  const { data: factorsData, error: factorsError } = factorsResult;
  if (factorsError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  const allFactors = factorsData?.all ?? [];
  const verified = allFactors.filter((factor) => factor.status === "verified");
  const requested = typeof body.factorId === "string"
    ? allFactors.find((candidate) => candidate.id === body.factorId)
    : undefined;
  if (typeof body.factorId === "string" && !requested) {
    return NextResponse.json({ error: "INVALID_MFA_FACTOR" }, { status: 400 });
  }
  // An explicit owned unverified factor is the enrollment ceremony. A normal
  // login never supplies one, and therefore picks verified factors only.
  if (assurance === "satisfied" && !requested) return NextResponse.json({ required: false });
  if (assurance === "satisfied" && requested?.status === "verified") return NextResponse.json({ required: false });
  if (assurance === "mfa_required" && requested && requested.status !== "verified" && verified.length > 0) {
    return NextResponse.json({ error: "MFA_FACTOR_NOT_ELIGIBLE" }, { status: 403 });
  }
  const factor = requested ?? verified[0];
  if (!factor) return NextResponse.json({ error: "MFA_FACTOR_UNAVAILABLE" }, { status: 409 });

  let challengeResult;
  try {
    challengeResult = await supabase.auth.mfa.challenge({ factorId: factor.id });
  } catch {
    return redactRouteError(new Error("MFA challenge provider unavailable"), {
      route: "auth/mfa/challenge", area: "auth", status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE", message: "MFA challenge is temporarily unavailable",
    });
  }
  const { data, error } = challengeResult;
  if (error || !data) {
    const status = error ? authProviderFailureStatus(error) : 503;
    return redactRouteError(new Error("MFA challenge provider failed"), {
      route: "auth/mfa/challenge", area: "auth", status,
      code: status === 503 ? "AUTH_BACKEND_UNAVAILABLE" : "MFA_CHALLENGE_REJECTED",
      message: status === 503 ? "MFA challenge is temporarily unavailable" : "MFA challenge was rejected",
    });
  }
  return NextResponse.json({ required: true, challengeId: data.id, factorId: factor.id });
}
