import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  createClient: vi.fn(),
  consumeChallenge: vi.fn(),
  commitAuthentication: vi.fn(),
  verifyAuthentication: vi.fn(),
  capture: vi.fn(),
  getUserById: vi.fn(),
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  getCookieUser: vi.fn(),
  admit: vi.fn(),
  listFactors: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mocks.createClient(),
}));
vi.mock("@/lib/security/passkeyMutations", () => ({
  consumeWebAuthnChallenge: (...args: unknown[]) => mocks.consumeChallenge(...args),
  commitPasskeyAuthentication: (...args: unknown[]) =>
    mocks.commitAuthentication(...args),
}));
vi.mock("@/lib/webauthn/server", () => ({
  buildAuthenticationOptions: vi.fn(),
  verifyAuthentication: (...args: unknown[]) => mocks.verifyAuthentication(...args),
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
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { GET, POST } from "./route";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PASSKEY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHALLENGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function passkeyQuery() {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({
    data: {
      id: PASSKEY_ID,
      user_id: USER_ID,
      credential_id: "credential_1",
      credential_public_key: "public-key",
      counter: 4,
      transports: ["internal"],
      last_used_at: null,
    },
    error: null,
  }));
  return query;
}

function request(credentialId = "credential_1", padding?: string) {
  return new NextRequest(
    "http://axis.test/api/auth/passkey/authenticate?action=verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: CHALLENGE_ID,
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: {
            authenticatorData: "authenticator-data",
            clientDataJSON: "client-data",
            signature: "signature",
            userHandle: Buffer.from(USER_ID).toString("base64url"),
          },
          clientExtensionResults: {},
          authenticatorAttachment: "platform",
        },
        ...(padding ? { padding } : {}),
      }),
    },
  );
}

describe("passkey authentication route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReset();
    mocks.consumeChallenge.mockResolvedValue({
      ok: true,
      challengeId: CHALLENGE_ID,
      challenge: "opaque-challenge",
    });
    mocks.verifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });
    mocks.commitAuthentication.mockResolvedValue({ ok: true });
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: USER_ID, email: "user@example.test" } },
      error: null,
    });
    mocks.generateLink.mockResolvedValue({
      data: {
        properties: { hashed_token: "server-only-hash" },
        user: { id: USER_ID },
      },
      error: null,
    });
    mocks.verifyOtp.mockResolvedValue({
      data: { session: { user: { id: USER_ID } }, user: { id: USER_ID } },
      error: null,
    });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.getCookieUser.mockResolvedValue({
      data: { user: { id: USER_ID } },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: { factors: [] },
      error: null,
    });
    mocks.admin.mockReturnValue({
      from: vi.fn(() => passkeyQuery()),
      auth: {
        admin: {
          getUserById: mocks.getUserById,
          generateLink: mocks.generateLink,
          mfa: { listFactors: mocks.listFactors },
        },
      },
    });
    mocks.createClient
      .mockResolvedValueOnce({
        auth: {
          verifyOtp: mocks.verifyOtp,
          signOut: mocks.signOut,
        },
      })
      .mockResolvedValueOnce({
        auth: { getUser: mocks.getCookieUser },
      });
  });

  it("consumes the exact challenge, wins the counter CAS, and issues only cookies", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ verified: true });
    expect(mocks.consumeChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: CHALLENGE_ID,
      type: "authentication",
      userId: null,
    }), expect.anything());
    expect(mocks.commitAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      passkeyId: PASSKEY_ID,
      expectedCounter: 4,
      newCounter: 5,
      expectedLastUsedAt: null,
    }), expect.anything());
    expect(mocks.getUserById).toHaveBeenCalledWith(USER_ID);
    expect(mocks.generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "user@example.test",
    });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      type: "magiclink",
      token_hash: "server-only-hash",
    });
    expect(mocks.getCookieUser).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(JSON.stringify(responseBody)).not.toMatch(/token|magiclink|email/i);
  });

  it("fails visibly when server-side session issuance fails", async () => {
    mocks.generateLink.mockResolvedValue({
      data: { properties: null, user: null },
      error: { code: "AUTH_DOWN" },
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "PASSKEY_SESSION_UNAVAILABLE",
    });
    expect(mocks.commitAuthentication).toHaveBeenCalledOnce();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("keeps successful sign-in but observes remembered-device projection failure", async () => {
    mocks.listFactors.mockRejectedValue(
      new Error("sensitive provider failure"),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: true });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        code: "MFA_TRUST_PROJECTION_FAILED",
        operation: "issue_mfa_trust",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "sensitive provider failure",
    );
  });

  it("clears the issued cookie and fails when the verified cookie owner mismatches", async () => {
    mocks.getCookieUser.mockResolvedValue({
      data: { user: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "PASSKEY_SESSION_UNAVAILABLE",
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("does not send an expected stale-counter conflict to Sentry", async () => {
    mocks.commitAuthentication.mockResolvedValue({
      ok: false,
      code: "COUNTER_CONFLICT",
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "PASSKEY_COUNTER_CONFLICT",
    });
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not consume a one-time challenge before owner admission succeeds", async () => {
    mocks.admit
      .mockResolvedValueOnce({ kind: "allowed" })
      .mockResolvedValueOnce({ kind: "limited", retryAfterSeconds: 60 });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
    expect(mocks.commitAuthentication).not.toHaveBeenCalled();
  });

  it("uses a broad global guard followed by the credential owner's tight quota", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.admit.mock.calls[0]).toEqual([
      "passkey-authentication-verify",
      expect.objectContaining({
        name: "passkey-auth-verify-global",
        limit: 300,
      }),
    ]);
    expect(mocks.admit.mock.calls[1]).toEqual([
      USER_ID,
      expect.objectContaining({
        name: "passkey-auth-owner",
        limit: 10,
      }),
    ]);
    expect(mocks.admit.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.consumeChallenge.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["options", () => GET(new NextRequest(
      "http://axis.test/api/auth/passkey/authenticate?action=options",
    ))],
    ["verify", () => POST(request())],
  ])("stops %s global exhaustion before challenge storage or lookup", async (_name, invoke) => {
    mocks.admit.mockResolvedValueOnce({
      kind: "limited",
      retryAfterSeconds: 30,
    });

    const response = await invoke();

    expect(response.status).toBe(429);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
  });

  it("rejects an oversized authentication body before credential lookup or challenge consumption", async () => {
    const response = await POST(
      request("credential_1", "x".repeat(70_000)),
    );

    expect(response.status).toBe(413);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
  });

  it("rejects an oversized credential identifier before credential lookup", async () => {
    const response = await POST(request("c".repeat(2_048)));

    expect(response.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
  });
});
