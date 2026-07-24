import crypto from "crypto";
import { optionalEnv } from "@/lib/env";
import { admitPlaidRequest } from "@/lib/plaid/admission";

export const PLAID_API_VERSION = "2020-09-14";

export async function admitPlaidMutation(
  userId: string,
  limit: number,
  prefix: string,
): Promise<"allowed" | "limited" | "unavailable"> {
  return admitPlaidRequest(userId, limit, Math.max(100, limit * 100), prefix);
}

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

type PlaidJwk = {
  alg: "ES256";
  crv: "P-256";
  kid: string;
  kty: "EC";
  use: "sig";
  x: string;
  y: string;
  created_at: number;
  expired_at: number | null;
};

const verificationKeyCache = new Map<string, { key: PlaidJwk; fetchedAt: number }>();
const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EC_COORDINATE = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_JWT_BYTES = 8_192;
const MAX_HEADER_BYTES = 1_024;
const MAX_PAYLOAD_BYTES = 4_096;
const MAX_SIGNATURE_BYTES = 128;
const MAX_JWK_RESPONSE_BYTES = 8_192;
const WEBHOOK_KEY_TIMEOUT_MS = 5_000;
const MAX_TOKEN_AGE_MS = 5 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 30 * 1_000;

export async function readBoundedPlaidBody(
  source: {
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
    signal?: AbortSignal;
  },
  maxBytes: number,
  limits: { totalMs?: number; idleMs?: number } = {},
): Promise<string | null> {
  const totalMs = limits.totalMs ?? 5_000;
  const idleMs = limits.idleMs ?? 1_000;
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 0
    || !Number.isSafeInteger(totalMs)
    || totalMs < 1
    || totalMs > 30_000
    || !Number.isSafeInteger(idleMs)
    || idleMs < 1
    || idleMs > totalMs
  ) return null;

  const cancelBody = (body: ReadableStream<Uint8Array>) => {
    try {
      void Promise.race([
        body.cancel().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    } catch {
      // The body may already be locked or cancelled. Cancellation is cleanup,
      // never part of the request's response-time critical path.
    }
  };
  const declaredHeader = source.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)) {
    if (source.body) cancelBody(source.body);
    return null;
  }
  if (!source.body) return "";
  const reader = source.body.getReader();
  const cancelReader = () => {
    try {
      void Promise.race([
        reader.cancel().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    } catch {
      // Best-effort cleanup only.
    }
  };
  const totalSignal = AbortSignal.timeout(totalMs);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const signals = [totalSignal, AbortSignal.timeout(idleMs)];
      if (source.signal) signals.push(source.signal);
      const signal = AbortSignal.any(signals);
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Plaid body read aborted", "AbortError"));
            return;
          }
          const onAbort = () => reject(new DOMException("Plaid body read aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
          reader.read().then(
            (result) => {
              signal.removeEventListener("abort", onAbort);
              resolve(result);
            },
            (error) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        },
      );
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancelReader();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    cancelReader();
    return null;
  }
}

export async function readBoundedPlaidJson(
  response: Response,
  maxBytes = 16_384,
): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedPlaidBody(response, maxBytes);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isPlaidJwk(value: unknown, requestedKid: string): value is PlaidJwk {
  if (!value || typeof value !== "object") return false;
  const key = value as Record<string, unknown>;
  return key.alg === "ES256"
    && key.crv === "P-256"
    && key.kty === "EC"
    && key.use === "sig"
    && key.kid === requestedKid
    && KEY_ID.test(key.kid)
    && typeof key.x === "string"
    && EC_COORDINATE.test(key.x)
    && typeof key.y === "string"
    && EC_COORDINATE.test(key.y)
    && Number.isSafeInteger(key.created_at)
    && (key.created_at as number) > 0
    && (
      key.expired_at === null
      || (Number.isSafeInteger(key.expired_at) && (key.expired_at as number) > 0)
    );
}

async function getPlaidVerificationKey(keyId: string): Promise<PlaidJwk | null> {
  if (!KEY_ID.test(keyId)) return null;
  const cached = verificationKeyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached.key;

  const creds = getPlaidCreds();
  if (!creds) return null;

  let res: Response;
  try {
    res = await fetch(`${plaidHost(creds.env)}/webhook_verification_key/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Plaid-Version": PLAID_API_VERSION },
      body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, key_id: keyId }),
      signal: AbortSignal.timeout(WEBHOOK_KEY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const raw = await readBoundedPlaidBody(res, MAX_JWK_RESPONSE_BYTES);
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const key = data && typeof data === "object"
    ? (data as { key?: unknown }).key
    : null;
  if (!isPlaidJwk(key, keyId)) return null;
  verificationKeyCache.set(keyId, { key, fetchedAt: Date.now() });
  return key;
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
  if (Buffer.byteLength(jwt, "utf8") > MAX_JWT_BYTES) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (
    !BASE64URL.test(headerB64)
    || !BASE64URL.test(payloadB64)
    || !BASE64URL.test(signatureB64)
  ) return null;

  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    const headerBytes = Buffer.from(headerB64, "base64url");
    const payloadBytes = Buffer.from(payloadB64, "base64url");
    const signatureBytes = Buffer.from(signatureB64, "base64url");
    if (
      headerBytes.byteLength > MAX_HEADER_BYTES
      || payloadBytes.byteLength > MAX_PAYLOAD_BYTES
      || signatureBytes.byteLength !== 64
      || signatureBytes.byteLength > MAX_SIGNATURE_BYTES
    ) return null;
    const parsedHeader: unknown = JSON.parse(headerBytes.toString("utf8"));
    const parsedPayload: unknown = JSON.parse(payloadBytes.toString("utf8"));
    if (
      !parsedHeader
      || typeof parsedHeader !== "object"
      || Array.isArray(parsedHeader)
      || !parsedPayload
      || typeof parsedPayload !== "object"
      || Array.isArray(parsedPayload)
    ) return null;
    header = parsedHeader as { kid?: string; alg?: string };
    payload = parsedPayload as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !KEY_ID.test(header.kid)) return null;

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

  if (!Number.isSafeInteger(payload.iat) || (payload.iat as number) <= 0) return null;
  const iat = (payload.iat as number) * 1000;
  const now = Date.now();
  if (now - iat > MAX_TOKEN_AGE_MS || iat - now > MAX_FUTURE_SKEW_MS) return null;
  if (
    (payload.iat as number) < jwk.created_at
    || (jwk.expired_at !== null && (payload.iat as number) > jwk.expired_at)
  ) return null;

  if (typeof payload.request_body_sha256 !== "string" || !SHA256_HEX.test(payload.request_body_sha256)) {
    return null;
  }
  const expectedHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const claimedHash = Buffer.from(payload.request_body_sha256, "hex");
  const actualHash = Buffer.from(expectedHash, "hex");
  if (claimedHash.byteLength !== actualHash.byteLength || !crypto.timingSafeEqual(claimedHash, actualHash)) {
    return null;
  }

  return payload;
}
