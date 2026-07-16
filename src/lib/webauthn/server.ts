import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { optionalEnv } from "@/lib/env";

export const RP_NAME = "Axis";

/** Derive rpID (bare domain) and origin from APP_URL env var or fallback. */
export function getRpConfig(): { rpID: string; origin: string } {
  const raw = optionalEnv("NEXT_PUBLIC_APP_URL") ?? optionalEnv("NEXT_PUBLIC_BASE_URL") ?? "http://localhost:3200";
  try {
    const url = new URL(raw);
    return { rpID: url.hostname, origin: url.origin };
  } catch {
    return { rpID: "localhost", origin: raw };
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function buildRegistrationOptions(
  userId: string,
  userEmail: string,
  existingCredentialIds: string[],
) {
  const { rpID } = getRpConfig();
  const userIdBytes = Buffer.from(userId, "utf8");

  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: userEmail,
    userID: userIdBytes,
    attestationType: "none",
    authenticatorSelection: {
      // Authentication is username-less (no allowCredentials), so every
      // registered credential must be discoverable.
      residentKey: "required",
      requireResidentKey: true,
      // Verification below requires UV; request it explicitly so the browser
      // does not offer a ceremony the server must reject.
      userVerification: "required",
    },
    excludeCredentials: existingCredentialIds.map((id) => ({
      id,
      transports: ["internal"] as AuthenticatorTransport[],
    })),
  });
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistrationResponse> {
  const { rpID, origin } = getRpConfig();
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin: origin,
    requireUserVerification: true,
  });
}

// ── Authentication ────────────────────────────────────────────────────────────

export async function buildAuthenticationOptions(credentialIds: string[]) {
  const { rpID } = getRpConfig();
  return generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: credentialIds.length
      ? credentialIds.map((id) => ({ id, transports: ["internal"] as AuthenticatorTransport[] }))
      : undefined,
  });
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  passkey: {
    credentialId: string;
    credentialPublicKey: string; // base64url
    counter: number;
    transports?: string[];
  },
): Promise<VerifiedAuthenticationResponse> {
  const { rpID, origin } = getRpConfig();
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin: origin,
    credential: {
      id: passkey.credentialId,
      publicKey: Buffer.from(passkey.credentialPublicKey, "base64url"),
      counter: passkey.counter,
      transports: (passkey.transports ?? []) as AuthenticatorTransport[],
    },
    requireUserVerification: true,
  });
}
