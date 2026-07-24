import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createClient: vi.fn(),
  admin: vi.fn(),
  consumeChallenge: vi.fn(),
  createPasskey: vi.fn(),
  verifyRegistration: vi.fn(),
  capture: vi.fn(),
  admit: vi.fn(),
  rotateEpoch: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mocks.createClient(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin(),
}));
vi.mock("@/lib/security/passkeyMutations", () => ({
  consumeWebAuthnChallenge: (...args: unknown[]) => mocks.consumeChallenge(...args),
  createUserPasskey: (...args: unknown[]) => mocks.createPasskey(...args),
  normalizeAuthenticatorAttachment: (value: unknown) =>
    value === "platform" || value === "cross-platform" ? value : null,
}));
vi.mock("@/lib/webauthn/server", () => ({
  buildRegistrationOptions: vi.fn(),
  verifyRegistration: (...args: unknown[]) => mocks.verifyRegistration(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: vi.fn(async () => null),
  memoryRateLimit: vi.fn(() => ({ success: true })),
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    passkeyRegister: {
      name: "passkey-register",
      limit: 10,
      window: "10 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));
vi.mock("@/lib/auth/securityState", () => ({
  rotateMfaTrustEpoch: (...args: unknown[]) => mocks.rotateEpoch(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { POST } from "./route";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHALLENGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function request(
  attachment: "platform" | "cross-platform" = "platform",
  credentialId = "credential_1",
  padding?: string,
) {
  return new NextRequest(
    "http://axis.test/api/auth/passkey/register?action=verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: CHALLENGE_ID,
        deviceName: "Laptop",
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: {
            attestationObject: "attestation",
            clientDataJSON: "client-data",
            transports: ["internal"],
          },
          clientExtensionResults: {},
          authenticatorAttachment: attachment,
        },
        ...(padding ? { padding } : {}),
      }),
    },
  );
}

describe("passkey registration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: USER_ID, email: "user@example.test" } },
      error: null,
    });
    mocks.createClient.mockResolvedValue({
      auth: { getUser: mocks.getUser },
    });
    mocks.admin.mockReturnValue({ rpc: vi.fn() });
    mocks.consumeChallenge.mockResolvedValue({
      ok: true,
      challengeId: CHALLENGE_ID,
      challenge: "opaque-challenge",
    });
    mocks.verifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "credential_1",
          publicKey: Uint8Array.from([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    mocks.createPasskey.mockResolvedValue({
      ok: true,
      passkeyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mocks.rotateEpoch.mockResolvedValue(2);
  });

  it("binds verification to the exact challenge and persists platform attachment", async () => {
    const response = await POST(request("platform"));

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      verified: true,
      passkeyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(mocks.consumeChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: CHALLENGE_ID,
      type: "registration",
      userId: USER_ID,
    }), expect.anything());
    expect(mocks.createPasskey).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      credentialId: "credential_1",
      deviceType: "platform",
      transports: ["internal"],
      name: "Laptop",
    }), expect.anything());
    expect(JSON.stringify(responseBody)).not.toMatch(/token|credential|challenge/i);
  });

  it("does not send expected verification failures to Sentry", async () => {
    mocks.verifyRegistration.mockRejectedValue(new Error("invalid assertion"));

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "PASSKEY_VERIFICATION_FAILED",
    });
    expect(mocks.createPasskey).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rotates remembered-device trust before persisting a new passkey", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.rotateEpoch).toHaveBeenCalledWith(
      expect.anything(),
      "passkey_register",
    );
    expect(mocks.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createPasskey.mock.invocationCallOrder[0],
    );
  });

  it("maps authentication backend failures to 503 rather than unauthenticated", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
  });

  it("rejects an oversized registration body before consuming a challenge or rotating trust", async () => {
    const response = await POST(
      request("platform", "credential_1", "x".repeat(70_000)),
    );

    expect(response.status).toBe(413);
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
    expect(mocks.verifyRegistration).not.toHaveBeenCalled();
    expect(mocks.rotateEpoch).not.toHaveBeenCalled();
    expect(mocks.createPasskey).not.toHaveBeenCalled();
  });

  it("rejects an oversized credential identifier before consuming the challenge", async () => {
    const response = await POST(request("platform", "c".repeat(2_048)));

    expect(response.status).toBe(400);
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
    expect(mocks.verifyRegistration).not.toHaveBeenCalled();
    expect(mocks.rotateEpoch).not.toHaveBeenCalled();
  });
});
