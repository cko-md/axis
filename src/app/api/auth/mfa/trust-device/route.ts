import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { optionalEnv } from "@/lib/env";
import { requireAuthenticatorAssurance } from "@/lib/auth/authenticatorAssurance";
import {
  MFA_TRUST_COOKIE,
  issueMfaTrustToken,
  resolveTrustWindowDays,
  verifyMfaTrustToken,
} from "@/lib/auth/mfaTrust";

// ── GET /api/auth/mfa/trust-device ───────────────────────────────────────────
// Reports whether THIS device holds a valid remembered-device token for the
// caller's own (server-verified) session. The trust cookie is httpOnly, so the
// login page cannot read it directly — this is the only way the client-side
// challenge gate can learn that a challenge is unnecessary before starting one.
//
// Read-only: verifies the presented cookie, never mints or refreshes one. The
// response reveals nothing beyond what the caller could learn by navigating
// (middleware already redirects untrusted aal1 sessions to the challenge).
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const verdict = await verifyMfaTrustToken({
    secret: optionalEnv("MFA_TRUST_SECRET"),
    token: req.cookies.get(MFA_TRUST_COOKIE)?.value,
    userId: user.id,
    nowMs: Date.now(),
  });

  if (verdict.trusted) return NextResponse.json({ trusted: true });
  return NextResponse.json({ trusted: false, reason: verdict.reason });
}

// ── POST /api/auth/mfa/trust-device ──────────────────────────────────────────
// Issues the remembered-device token after the browser has completed an MFA
// challenge, so an enrolled account is not re-challenged on every sign-in.
//
// The login challenge is performed client-side against the Supabase SDK
// (MFAChallenge.tsx calls supabase.auth.mfa.verify directly), which is what
// elevates the browser session to aal2. This route exists because that path
// never reaches a server handler, so without it the trust cookie would never be
// minted during a real login and the feature would be inert.
//
// SECURITY: the client's claim to have passed MFA is NOT trusted. The server
// independently re-reads the assurance level for the caller's own session and
// mints nothing unless Supabase itself reports aal2. A caller who has not
// actually completed a challenge gets a 403 no matter what it sends — the
// request body is ignored entirely.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const assurance = await requireAuthenticatorAssurance(supabase);
  if (assurance !== "satisfied") {
    return NextResponse.json(
      { error: "MFA_NOT_SATISFIED", message: "Complete the second factor before trusting this device." },
      { status: 403 },
    );
  }

  // Bind the token to the factor that actually proved the challenge, so
  // unenrolling or re-enrolling a factor invalidates every remembered device.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedFactor = (factorsData?.all ?? []).find(
    (factor: { id: string; status: string }) => factor.status === "verified",
  );
  if (!verifiedFactor) {
    return NextResponse.json(
      { error: "NO_VERIFIED_FACTOR", message: "No verified second factor is enrolled." },
      { status: 403 },
    );
  }

  const issued = await issueMfaTrustToken({
    secret: optionalEnv("MFA_TRUST_SECRET"),
    userId: user.id,
    factorId: verifiedFactor.id,
    nowMs: Date.now(),
    windowDays: resolveTrustWindowDays(optionalEnv("MFA_TRUST_WINDOW_DAYS")),
  });

  // No secret configured => the feature is off. Report it honestly rather than
  // pretending the device was remembered.
  if (!issued) {
    return NextResponse.json({ trusted: false, reason: "not_configured" });
  }

  const response = NextResponse.json({ trusted: true, expiresInSeconds: issued.maxAgeSeconds });
  response.cookies.set(MFA_TRUST_COOKIE, issued.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: issued.maxAgeSeconds,
    path: "/",
  });
  return response;
}
