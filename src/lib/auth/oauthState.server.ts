import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isProfileSubject } from "@/lib/auth/profileSubject";

export type DirectOAuthProvider = "spotify" | "strava";

const STATE_VERSION = 1;
const STATE_PURPOSE = "axis-direct-provider-oauth";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const MAX_STATE_LENGTH = 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type OAuthStatePayload = {
  v: typeof STATE_VERSION;
  purpose: typeof STATE_PURPOSE;
  provider: DirectOAuthProvider;
  subject: string;
  nonce: string;
  iat: number;
  iatMs: number;
  exp: number;
};

type VerifiedOAuthStateOptions = {
  provider: DirectOAuthProvider;
  subject: string;
  secret: string;
  sealedState: string | null;
  nowMs?: number;
};

function signingKey(secret: string, provider: DirectOAuthProvider): Buffer {
  return createHmac("sha256", secret)
    .update(`axis:oauth-state:key:v${STATE_VERSION}:${provider}`)
    .digest();
}

function signature(
  encodedPayload: string,
  secret: string,
  provider: DirectOAuthProvider,
): Buffer {
  return createHmac("sha256", signingKey(secret, provider))
    .update(`axis:oauth-state:payload:v${STATE_VERSION}\0${encodedPayload}`)
    .digest();
}

function exactPayloadKeys(payload: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(payload).sort()) === JSON.stringify([
    "exp",
    "iat",
    "iatMs",
    "nonce",
    "provider",
    "purpose",
    "subject",
    "v",
  ]);
}

export function createOAuthPendingState(options: {
  provider: DirectOAuthProvider;
  subject: string;
  secret: string;
  nowMs?: number;
  nonce?: string;
}): { providerState: string; sealedState: string } {
  const { provider, subject, secret } = options;
  if (!isProfileSubject(subject) || !secret) {
    throw new Error("OAUTH_STATE_CONFIGURATION_INVALID");
  }
  const nonce = options.nonce ?? randomBytes(32).toString("base64url");
  if (!NONCE_PATTERN.test(nonce)) throw new Error("OAUTH_STATE_NONCE_INVALID");
  const iatMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(iatMs) || iatMs < 0) {
    throw new Error("OAUTH_STATE_TIME_INVALID");
  }
  const iat = Math.floor(iatMs / 1000);
  const payload: OAuthStatePayload = {
    v: STATE_VERSION,
    purpose: STATE_PURPOSE,
    provider,
    subject,
    nonce,
    iat,
    iatMs,
    exp: iat + OAUTH_STATE_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const encodedSignature = signature(encodedPayload, secret, provider).toString("base64url");
  return {
    providerState: nonce,
    sealedState: `${encodedPayload}.${encodedSignature}`,
  };
}

function authenticatedOAuthStatePayload(
  options: VerifiedOAuthStateOptions,
): OAuthStatePayload | null {
  const { provider, subject, secret, sealedState } = options;
  if (
    !secret ||
    !isProfileSubject(subject) ||
    !sealedState ||
    sealedState.length > MAX_STATE_LENGTH
  ) {
    return null;
  }
  const parts = sealedState.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const suppliedSignature = Buffer.from(parts[1], "base64url");
    const expectedSignature = signature(parts[0], secret, provider);
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Record<string, unknown>;
    if (!exactPayloadKeys(payload)) return null;
    if (
      payload.v === STATE_VERSION &&
      payload.purpose === STATE_PURPOSE &&
      payload.provider === provider &&
      payload.subject === subject &&
      typeof payload.nonce === "string" &&
      NONCE_PATTERN.test(payload.nonce) &&
      typeof payload.iat === "number" &&
      Number.isSafeInteger(payload.iat) &&
      typeof payload.iatMs === "number" &&
      Number.isSafeInteger(payload.iatMs) &&
      payload.iatMs >= 0 &&
      Math.floor(payload.iatMs / 1000) === payload.iat &&
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp - payload.iat === OAUTH_STATE_TTL_SECONDS
    ) {
      return payload as OAuthStatePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function verifiedOAuthStatePayload(
  options: VerifiedOAuthStateOptions,
): OAuthStatePayload | null {
  const payload = authenticatedOAuthStatePayload(options);
  if (!payload) return null;
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  return payload.iat <= now && now < payload.exp ? payload : null;
}

/**
 * Authenticates a pending attempt without applying local wall-clock validity.
 * Disconnect uses this only to advance its logical cutoff past signed attempts
 * visible in the request, including when serverless instances have clock skew.
 */
export function authenticatedOAuthPendingStateIssuedAt(
  options: VerifiedOAuthStateOptions & { providerState?: string | null },
): number | null {
  const payload = authenticatedOAuthStatePayload(options);
  if (!payload) return null;
  if (options.providerState === undefined) return payload.iatMs;
  return options.providerState === payload.nonce ? payload.iatMs : null;
}

export function oauthPendingStateBelongsToSubject(
  options: VerifiedOAuthStateOptions,
): boolean {
  return verifiedOAuthStatePayload(options) !== null;
}

export function verifyOAuthPendingState(options: VerifiedOAuthStateOptions & {
  providerState: string | null;
}): boolean {
  return verifiedOAuthPendingStateIssuedAt(options) !== null;
}

export function verifiedOAuthPendingStateIssuedAt(
  options: VerifiedOAuthStateOptions & { providerState: string | null },
): number | null {
  const { providerState } = options;
  if (!providerState || !NONCE_PATTERN.test(providerState)) return null;
  const payload = verifiedOAuthStatePayload(options);
  return payload?.nonce === providerState ? payload.iatMs : null;
}
