/**
 * Remembered-device trust for the SESSION-level second factor.
 *
 * Supabase models MFA with assurance levels: every new session starts at aal1,
 * and `nextLevel` becomes aal2 whenever the account has a verified factor. That
 * is why an enrolled account was challenged on *every* sign-in — there is no
 * built-in notion of "I already proved this on this device recently".
 *
 * This module issues a signed, httpOnly device token on a successful MFA
 * verification and lets middleware accept it, for a bounded window, in place of
 * a fresh challenge.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────
 * It does not authenticate anybody. Middleware has already established the user
 * via `getUser()` before this is consulted; the token only decides whether an
 * *already authenticated* aal1 session must be elevated. A stolen token cannot
 * sign in.
 *
 * It also has no bearing on per-action step-up. FINANCIAL_EXECUTION and
 * DESTRUCTIVE_ADMIN still require a fresh WebAuthn ceremony per approval — see
 * src/lib/security/actionPolicy.ts, which contains no reference to assurance
 * levels at all. The financial safety kernel is untouched by this file.
 *
 * ── Fail-closed ──────────────────────────────────────────────────────────────
 * Every failure path returns false. A missing secret, a malformed token, a bad
 * signature, an expired window, a different user, or a changed factor all mean
 * "challenge the user". There is no path where an error grants trust.
 *
 * Tokens are bound to a server-owned per-user epoch. Security mutations rotate
 * the epoch before their provider/DB side effect, immediately invalidating
 * remembered tokens on every device.
 */

const ENCODER = new TextEncoder();

/** Default remembered-device window. Overridable via MFA_TRUST_WINDOW_DAYS. */
export const DEFAULT_MFA_TRUST_WINDOW_DAYS = 30;

/** Hard ceiling — a longer window is treated as a misconfiguration, not honored. */
export const MAX_MFA_TRUST_WINDOW_DAYS = 90;

export const MFA_TRUST_COOKIE = "axis_mfa_trust";

export type MfaTrustPayload = {
  /** Subject: the user this token was minted for. */
  sub: string;
  /** Factor id proven at mint time. Re-enrolling a factor invalidates the token. */
  fid: string;
  /** Server-owned revocation generation. */
  epoch: number;
  /** Issued at (epoch ms). */
  iat: number;
  /** Expires at (epoch ms). */
  exp: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Web Crypto, not node:crypto — this runs in middleware on the Edge runtime.
async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, ENCODER.encode(message));
  return new Uint8Array(signature);
}

/** Length-independent comparison, so a mismatch leaks no positional information. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function resolveTrustWindowDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_MFA_TRUST_WINDOW_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MFA_TRUST_WINDOW_DAYS;
  return Math.min(Math.floor(parsed), MAX_MFA_TRUST_WINDOW_DAYS);
}

/**
 * Mint a device-trust token. Returns null when no secret is configured, so the
 * caller sets no cookie and the account simply keeps being challenged.
 */
export async function issueMfaTrustToken(input: {
  secret: string | undefined;
  userId: string;
  factorId: string;
  trustEpoch?: number;
  nowMs: number;
  windowDays: number;
}): Promise<{ token: string; maxAgeSeconds: number } | null> {
  if (!input.secret) return null;
  const trustEpoch = input.trustEpoch ?? 1;
  if (!input.userId || !input.factorId || !Number.isSafeInteger(trustEpoch) || trustEpoch < 1) return null;

  const windowMs = input.windowDays * 24 * 60 * 60 * 1000;
  const payload: MfaTrustPayload = {
    sub: input.userId,
    fid: input.factorId,
    epoch: trustEpoch,
    iat: input.nowMs,
    exp: input.nowMs + windowMs,
  };
  const body = base64UrlEncode(ENCODER.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(input.secret, body));
  return {
    token: `${body}.${signature}`,
    maxAgeSeconds: Math.floor(windowMs / 1000),
  };
}

export type MfaTrustVerdict =
  | { trusted: true; payload: MfaTrustPayload }
  | {
      trusted: false;
      reason:
        | "not_configured"
        | "absent"
        | "malformed"
        | "bad_signature"
        | "expired"
        | "wrong_user"
        | "wrong_epoch";
    };

export function isMfaTrustFactorCurrent(
  verdict: MfaTrustVerdict,
  factors: readonly { id: string; status: string }[],
): boolean {
  return verdict.trusted
    && factors.some(
      (factor) =>
        factor.id === verdict.payload.fid
        && factor.status === "verified",
    );
}

/**
 * Decide whether a presented token lets an aal1 session skip its challenge.
 *
 * `userId` MUST come from a server-verified `getUser()` call, never from the
 * token itself — the token's own `sub` is only checked for agreement.
 */
export async function verifyMfaTrustToken(input: {
  secret: string | undefined;
  token: string | undefined;
  userId: string;
  trustEpoch?: number;
  nowMs: number;
}): Promise<MfaTrustVerdict> {
  if (!input.secret) return { trusted: false, reason: "not_configured" };
  if (!input.token) return { trusted: false, reason: "absent" };

  const parts = input.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { trusted: false, reason: "malformed" };
  }
  const [body, signature] = parts;

  const presented = base64UrlDecode(signature);
  if (!presented) return { trusted: false, reason: "malformed" };

  // Signature is checked BEFORE the payload is parsed, so unauthenticated input
  // is never interpreted as structured data.
  const expected = await hmac(input.secret, body);
  if (!timingSafeEqual(presented, expected)) {
    return { trusted: false, reason: "bad_signature" };
  }

  const decoded = base64UrlDecode(body);
  if (!decoded) return { trusted: false, reason: "malformed" };

  let payload: MfaTrustPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded)) as MfaTrustPayload;
  } catch {
    return { trusted: false, reason: "malformed" };
  }

  if (
    typeof payload?.sub !== "string"
    || typeof payload?.fid !== "string"
    || typeof payload?.exp !== "number"
    || typeof payload?.iat !== "number"
    || !Number.isSafeInteger(payload?.epoch)
    || payload.epoch < 1
  ) {
    return { trusted: false, reason: "malformed" };
  }

  if (payload.exp <= input.nowMs) return { trusted: false, reason: "expired" };
  if (payload.sub !== input.userId) return { trusted: false, reason: "wrong_user" };
  if (payload.epoch !== (input.trustEpoch ?? 1)) return { trusted: false, reason: "wrong_epoch" };

  return { trusted: true, payload };
}
