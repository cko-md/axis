import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBoundedPlaidBody, verifyPlaidWebhook } from "./_lib";

const originalFetch = global.fetch;

function fixture(kid: string, body: string, overrides: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const now = Math.floor(Date.now() / 1_000);
  const payload = {
    iat: now,
    request_body_sha256: crypto.createHash("sha256").update(body).digest("hex"),
    ...overrides,
  };
  const header = { alg: "ES256", kid };
  const headerPart = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  const exported = publicKey.export({ format: "jwk" });
  return {
    jwt: `${headerPart}.${payloadPart}.${signature}`,
    jwk: {
      ...exported,
      alg: "ES256",
      crv: "P-256",
      kty: "EC",
      use: "sig",
      kid,
      created_at: now - 60,
      expired_at: null,
    },
    now,
  };
}

function keyResponse(key: unknown) {
  return new Response(JSON.stringify({ key }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Plaid webhook verification boundary", () => {
  beforeEach(() => {
    vi.stubEnv("PLAID_CLIENT_ID", "client");
    vi.stubEnv("PLAID_SECRET", "secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("accepts a valid signature and rejects tampered content in constant-length hash form", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "item" });
    const value = fixture("valid-key", body);
    global.fetch = vi.fn(async () => keyResponse(value.jwk));
    expect(await verifyPlaidWebhook(value.jwt, body)).toMatchObject({ iat: value.now });
    expect(await verifyPlaidWebhook(value.jwt, `${body} `)).toBeNull();
  });

  it("rejects future issuance, issuance outside key validity, and mismatched key ids", async () => {
    const body = "{}";
    const future = fixture("future-key", body, { iat: Math.floor(Date.now() / 1_000) + 120 });
    global.fetch = vi.fn(async () => keyResponse(future.jwk));
    expect(await verifyPlaidWebhook(future.jwt, body)).toBeNull();

    const expired = fixture("expired-key", body);
    global.fetch = vi.fn(async () => keyResponse({
      ...expired.jwk,
      expired_at: expired.now - 1,
    }));
    expect(await verifyPlaidWebhook(expired.jwt, body)).toBeNull();

    const mismatch = fixture("requested-key", body);
    global.fetch = vi.fn(async () => keyResponse({ ...mismatch.jwk, kid: "other-key" }));
    expect(await verifyPlaidWebhook(mismatch.jwt, body)).toBeNull();
  });

  it("cleanly rejects null/array payloads and oversized or malformed JWTs", async () => {
    const value = fixture("shape-key", "{}");
    global.fetch = vi.fn(async () => keyResponse(value.jwk));
    const [header, , signature] = value.jwt.split(".");
    expect(await verifyPlaidWebhook(`${header}.${Buffer.from("null").toString("base64url")}.${signature}`, "{}")).toBeNull();
    expect(await verifyPlaidWebhook(`${header}.${Buffer.from("[]").toString("base64url")}.${signature}`, "{}")).toBeNull();
    expect(await verifyPlaidWebhook(`${"a".repeat(8_193)}.a.a`, "{}")).toBeNull();
    expect(await verifyPlaidWebhook("not-a-jwt", "{}")).toBeNull();
  });

  it("rejects oversized and malformed JWK responses without caching them", async () => {
    const value = fixture("bad-jwk-key", "{}");
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("x".repeat(8_193), { status: 200 }))
      .mockResolvedValueOnce(keyResponse({ ...value.jwk, x: "bad" }));
    expect(await verifyPlaidWebhook(value.jwt, "{}")).toBeNull();
    expect(await verifyPlaidWebhook(value.jwt, "{}")).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("bounded Plaid body reader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed on a slow-drip body at the idle deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = readBoundedPlaidBody(
      { headers: new Headers(), body },
      128,
      { totalMs: 1_000, idleMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(51);

    await expect(pending).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it("does not wait for a hostile cancel promise after an oversized chunk", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(129));
      },
      cancel() {
        return new Promise(() => undefined);
      },
    });

    await expect(readBoundedPlaidBody(
      { headers: new Headers(), body },
      128,
      { totalMs: 1_000, idleMs: 100 },
    )).resolves.toBeNull();
  });
});
