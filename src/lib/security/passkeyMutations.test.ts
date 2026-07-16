import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  commitPasskeyAuthentication,
  consumeWebAuthnChallenge,
  createUserPasskey,
  deleteUserPasskey,
  normalizeAuthenticatorAttachment,
} from "./passkeyMutations";

function client(data: unknown, error: unknown = null) {
  return {
    rpc: vi.fn(async () => ({ data, error })),
  } as unknown as SupabaseClient;
}

describe("atomic passkey mutations", () => {
  it("strictly parses a consumed one-time challenge", async () => {
    const result = await consumeWebAuthnChallenge({
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "registration",
      userId: "user_1",
      now: "2026-07-16T00:00:00.000Z",
    }, client({
      outcome: "consumed",
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      challenge: "opaque-challenge",
    }));

    expect(result).toEqual({
      ok: true,
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      challenge: "opaque-challenge",
    });
  });

  it("fails closed for consumed, missing, and malformed challenge outcomes", async () => {
    await expect(consumeWebAuthnChallenge({
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "authentication",
      userId: null,
      now: "2026-07-16T00:00:00.000Z",
    }, client({ outcome: "not_found" }))).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });

    await expect(consumeWebAuthnChallenge({
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "authentication",
      userId: null,
      now: "2026-07-16T00:00:00.000Z",
    }, client({ outcome: "consumed", challenge: "missing-id" }))).resolves.toEqual({
      ok: false,
      code: "INVALID_RESPONSE",
    });
  });

  it("creates a passkey only from a complete atomic response", async () => {
    const result = await createUserPasskey({
      userId: "user_1",
      credentialId: "credential_1",
      credentialPublicKey: "public-key",
      counter: 0,
      deviceType: "platform",
      backedUp: false,
      transports: ["internal"],
      name: "This device",
    }, client({ outcome: "created", passkeyId: "passkey_1" }));

    expect(result).toEqual({ ok: true, passkeyId: "passkey_1" });
    await expect(createUserPasskey({
      userId: "user_1",
      credentialId: "credential_1",
      credentialPublicKey: "public-key",
      counter: 0,
      deviceType: null,
      backedUp: false,
      transports: [],
      name: "This device",
    }, client({ outcome: "credential_exists" }))).resolves.toEqual({
      ok: false,
      code: "CREDENTIAL_EXISTS",
    });
  });

  it("reports counter conflicts and RPC failures without treating them as success", async () => {
    const input = {
      userId: "user_1",
      passkeyId: "passkey_1",
      expectedCounter: 4,
      newCounter: 5,
      expectedLastUsedAt: null,
      usedAt: "2026-07-16T00:00:00.000Z",
    };

    await expect(commitPasskeyAuthentication(
      input,
      client({ outcome: "updated" }),
    )).resolves.toEqual({ ok: true });
    await expect(commitPasskeyAuthentication(
      input,
      client({ outcome: "counter_conflict" }),
    )).resolves.toEqual({ ok: false, code: "COUNTER_CONFLICT" });
    await expect(commitPasskeyAuthentication(
      input,
      client(null, { code: "DB_DOWN" }),
    )).resolves.toEqual({ ok: false, code: "RPC_FAILED" });
  });

  it("requires the service-role mutation boundary", async () => {
    await expect(commitPasskeyAuthentication({
      userId: "user_1",
      passkeyId: "passkey_1",
      expectedCounter: 0,
      newCounter: 0,
      expectedLastUsedAt: null,
      usedAt: "2026-07-16T00:00:00.000Z",
    }, null)).resolves.toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
  });

  it("maps only WebAuthn attachment values accepted by the schema", () => {
    expect(normalizeAuthenticatorAttachment("platform")).toBe("platform");
    expect(normalizeAuthenticatorAttachment("cross-platform")).toBe("cross-platform");
    expect(normalizeAuthenticatorAttachment("singleDevice")).toBeNull();
    expect(normalizeAuthenticatorAttachment(undefined)).toBeNull();
  });

  it("strictly parses atomic deletion and remaining-passkey state", async () => {
    await expect(deleteUserPasskey({
      userId: "user_1",
      passkeyId: "passkey_1",
    }, client({ outcome: "deleted", hasPasskeys: false }))).resolves.toEqual({
      ok: true,
      hasPasskeys: false,
    });

    await expect(deleteUserPasskey({
      userId: "user_1",
      passkeyId: "passkey_1",
    }, client({ outcome: "not_found" }))).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});
