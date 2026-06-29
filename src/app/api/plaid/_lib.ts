import crypto from "crypto";
import { optionalEnv } from "@/lib/env";

/**
 * Plaid credential and host helpers — shared across plaid routes.
 * Extracted here so that route.ts files only export valid HTTP verb handlers.
 */
export function getPlaidCreds() {
  const clientId = optionalEnv("PLAID_CLIENT_ID");
  const secret = optionalEnv("PLAID_SECRET");
  const env = optionalEnv("PLAID_ENV") || "sandbox";
  if (!clientId || !secret) return null;
  return { clientId, secret, env };
}

export function plaidHost(env: string) {
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

type PlaidJwk = Record<string, unknown> & { kid: string };

const verificationKeyCache = new Map<string, { key: PlaidJwk; fetchedAt: number }>();

async function getPlaidVerificationKey(keyId: string): Promise<PlaidJwk | null> {
  const cached = verificationKeyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached.key;

  const creds = getPlaidCreds();
  if (!creds) return null;

  const res = await fetch(`${plaidHost(creds.env)}/webhook_verification_key/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, key_id: keyId }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { key?: PlaidJwk };
  if (!data.key) return null;
  verificationKeyCache.set(keyId, { key: data.key, fetchedAt: Date.now() });
  return data.key;
}

/**
 * Verifies a Plaid webhook's `Plaid-Verification` JWT against the raw
 * request body (security boundary: never trust an unsigned inbound
 * webhook). Returns the verified payload, or null on any failure — caller
 * should respond 401 and do nothing further.
 *
 * Checks: ES256 signature against Plaid's published JWK (cached 24h),
 * `iat` within the last 5 minutes (replay protection), and the body's
 * SHA-256 matches the `request_body_sha256` claim (tamper protection).
 */
export async function verifyPlaidWebhook(
  jwt: string,
  rawBody: string,
): Promise<Record<string, unknown> | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || !header.kid) return null;

  const jwk = await getPlaidVerificationKey(header.kid);
  if (!jwk) return null;

  try {
    const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
    const signature = Buffer.from(signatureB64, "base64url");
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
    const valid = crypto.verify(
      "sha256",
      signedData,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  const iat = Number(payload.iat) * 1000;
  if (!iat || Date.now() - iat > 5 * 60 * 1000) return null;

  const expectedHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  if (payload.request_body_sha256 !== expectedHash) return null;

  return payload;
}
