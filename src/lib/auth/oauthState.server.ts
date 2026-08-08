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
  exp: number;
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
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const payload: OAuthStatePayload = {
    v: STATE_VERSION,
    purpose: STATE_PURPOSE,
    provider,
    subject,
    nonce,
    iat,
    exp: iat + OAUTH_STATE_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const encodedSignature = signature(encodedPayload, secret, provider).toString("base64url");
  return {
    providerState: nonce,
    sealedState: `${encodedPayload}.${encodedSignature}`,
  };
}

export function verifyOAuthPendingState(options: {
  provider: DirectOAuthProvider;
  subject: string;
  secret: string;
  providerState: string | null;
  sealedState: string | null;
  nowMs?: number;
}): boolean {
  const { provider, subject, secret, providerState, sealedState } = options;
  if (
    !secret ||
    !isProfileSubject(subject) ||
    !providerState ||
    !NONCE_PATTERN.test(providerState) ||
    !sealedState ||
    sealedState.length > MAX_STATE_LENGTH
  ) {
    return false;
  }
  const parts = sealedState.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  try {
    const suppliedSignature = Buffer.from(parts[1], "base64url");
    const expectedSignature = signature(parts[0], secret, provider);
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      return false;
    }
    const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const payload = parsed as Record<string, unknown>;
    if (!exactPayloadKeys(payload)) return false;
    const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
    return (
      payload.v === STATE_VERSION &&
      payload.purpose === STATE_PURPOSE &&
      payload.provider === provider &&
      payload.subject === subject &&
      payload.nonce === providerState &&
      typeof payload.iat === "number" &&
      Number.isSafeInteger(payload.iat) &&
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp - payload.iat === OAUTH_STATE_TTL_SECONDS &&
      payload.iat <= now &&
      now < payload.exp
    );
  } catch {
    return false;
  }
}
