import { describe, expect, it, vi } from "vitest";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import {
  createPasskeyOperations,
  supportsPasskeys,
} from "./usePasskey";

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

const authenticationResponse = {
  id: "credential_1",
  rawId: "credential_1",
  type: "public-key",
  response: {
    authenticatorData: "authenticator-data",
    clientDataJSON: "client-data",
    signature: "signature",
  },
  clientExtensionResults: {},
  authenticatorAttachment: "platform",
} as AuthenticationResponseJSON;

const registrationResponse = {
  id: "credential_1",
  rawId: "credential_1",
  type: "public-key",
  response: {
    attestationObject: "attestation",
    clientDataJSON: "client-data",
    transports: ["internal"],
  },
  clientExtensionResults: {},
  authenticatorAttachment: "platform",
} as RegistrationResponseJSON;

describe("passkey client operations", () => {
  it("detects support without touching browser globals during SSR", () => {
    expect(supportsPasskeys(undefined)).toBe(false);
    expect(supportsPasskeys({
      PublicKeyCredential: class {},
      isSecureContext: false,
      navigator: { credentials: {} },
    })).toBe(false);
    expect(supportsPasskeys({
      PublicKeyCredential: class {},
      isSecureContext: true,
      navigator: { credentials: {} },
    })).toBe(true);
  });

  it("returns the exact authentication challenge ID without sending any token", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        options: { challenge: "opaque-challenge" },
        challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }))
      .mockResolvedValueOnce(jsonResponse({ verified: true }));
    const operations = createPasskeyOperations({
      fetcher,
      startRegistration: vi.fn(),
      startAuthentication: vi.fn(async () => authenticationResponse),
      verifySession: vi.fn(async () => true),
      clearSession: vi.fn(async () => undefined),
    });

    await expect(operations.authenticate()).resolves.toEqual({ ok: true });

    const [, verifyInit] = fetcher.mock.calls[1];
    const payload = JSON.parse(String(verifyInit?.body));
    expect(payload.challengeId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(payload.response).toEqual(authenticationResponse);
    expect(Object.keys(payload).sort()).toEqual(["challengeId", "response"]);
    expect(JSON.stringify(payload)).not.toMatch(/refresh.?token|access.?token|token_hash/i);
  });

  it("fails closed when the server response did not establish a usable session", async () => {
    const clearSession = vi.fn(async () => undefined);
    const operations = createPasskeyOperations({
      fetcher: vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          options: { challenge: "opaque-challenge" },
          challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }))
        .mockResolvedValueOnce(jsonResponse({ verified: true })),
      startRegistration: vi.fn(),
      startAuthentication: vi.fn(async () => authenticationResponse),
      verifySession: vi.fn(async () => false),
      clearSession,
    });

    await expect(operations.authenticate()).resolves.toEqual({
      ok: false,
      error: "Passkey session restoration failed",
    });
    expect(clearSession).toHaveBeenCalledOnce();
  });

  it("binds registration verification to its returned challenge ID", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        options: {
          challenge: "opaque-registration-challenge",
          rp: { name: "Axis", id: "axis.test" },
          user: { id: "user_1", name: "user@example.test", displayName: "user@example.test" },
          pubKeyCredParams: [],
        },
        challengeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }))
      .mockResolvedValueOnce(jsonResponse({
        verified: true,
        passkeyId: "passkey_1",
      }));
    const operations = createPasskeyOperations({
      fetcher,
      startRegistration: vi.fn(async () => registrationResponse),
      startAuthentication: vi.fn(),
      verifySession: vi.fn(async () => true),
      clearSession: vi.fn(async () => undefined),
    });

    await expect(operations.register("Laptop")).resolves.toEqual({
      ok: true,
      passkeyId: "passkey_1",
    });

    const [, verifyInit] = fetcher.mock.calls[1];
    expect(JSON.parse(String(verifyInit?.body))).toEqual({
      response: registrationResponse,
      challengeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceName: "Laptop",
    });
  });
});
