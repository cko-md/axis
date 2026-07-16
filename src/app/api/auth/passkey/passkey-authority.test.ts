import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as registrationOptions, POST as register } from "./register/route";
import { GET as listPasskeys } from "./list/route";
import { DELETE as remove } from "./delete/route";
import { GET as authenticationOptions, POST as authenticate } from "./authenticate/route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  sessionFrom: vi.fn(),
  adminFrom: vi.fn(),
  createAdminClient: vi.fn(),
  getUserById: vi.fn(),
  generateLink: vi.fn(),
  buildRegistrationOptions: vi.fn(),
  buildAuthenticationOptions: vi.fn(),
  verifyRegistration: vi.fn(),
  verifyAuthentication: vi.fn(),
  redisRateLimit: vi.fn(),
  memoryRateLimit: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mocks.getUser,
      verifyOtp: mocks.verifyOtp,
      signOut: mocks.signOut,
    },
    from: mocks.sessionFrom,
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/webauthn/server", () => ({
  buildRegistrationOptions: mocks.buildRegistrationOptions,
  buildAuthenticationOptions: mocks.buildAuthenticationOptions,
  verifyRegistration: mocks.verifyRegistration,
  verifyAuthentication: mocks.verifyAuthentication,
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: mocks.redisRateLimit,
  memoryRateLimit: mocks.memoryRateLimit,
}));

const CEREMONY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CEREMONY_ID = "22222222-2222-4222-8222-222222222222";
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

type QueryResult = {
  data: unknown;
  error: unknown;
  count?: number | null;
};

function query(result: QueryResult) {
  const value: Record<string, unknown> = {};
  for (const method of [
    "select",
    "insert",
    "update",
    "delete",
    "upsert",
    "eq",
    "gt",
    "lt",
    "order",
    "limit",
  ]) {
    value[method] = vi.fn(() => value);
  }
  value.single = vi.fn(async () => result);
  value.maybeSingle = vi.fn(async () => result);
  value.then = (
    resolve: (result: QueryResult) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return value as Record<string, ReturnType<typeof vi.fn>> & {
    then: (
      resolve: (result: QueryResult) => unknown,
      reject: (error: unknown) => unknown,
    ) => Promise<unknown>;
  };
}

function useAdminQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.adminFrom.mockImplementation(() => queue.shift());
}

function registrationRequest(ceremonyId = CEREMONY_ID) {
  return new NextRequest("http://axis.test/api/auth/passkey/register?action=verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response: {
        id: "credential-1",
        rawId: "credential-1",
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: "client-data",
          attestationObject: "attestation",
          transports: ["internal"],
        },
        clientExtensionResults: {},
      },
      ceremonyId,
      deviceName: "Laptop",
    }),
  });
}

function authenticationRequest(ceremonyId = CEREMONY_ID) {
  return new NextRequest("http://axis.test/api/auth/passkey/authenticate?action=verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({
      response: {
        id: "credential-1",
        rawId: "credential-1",
        type: "public-key",
        response: {
          authenticatorData: "authenticator-data",
          clientDataJSON: "client-data",
          signature: "signature",
          userHandle: Buffer.from("user_1").toString("base64url"),
        },
        clientExtensionResults: {},
      },
      ceremonyId,
    }),
  });
}

describe("passkey credential DML authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1", email: "owner@example.test" } },
      error: null,
    });
    mocks.verifyOtp.mockResolvedValue({
      data: {
        session: {
          user: { id: "user_1" },
        },
      },
      error: null,
    });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.getUserById.mockResolvedValue({
      data: {
        user: { id: "user_1", email: "owner@example.test" },
      },
      error: null,
    });
    mocks.generateLink.mockResolvedValue({
      data: {
        properties: { hashed_token: "one-time-hash" },
        user: { id: "user_1" },
      },
      error: null,
    });
    mocks.createAdminClient.mockReturnValue({
      from: mocks.adminFrom,
      auth: {
        admin: {
          getUserById: mocks.getUserById,
          generateLink: mocks.generateLink,
        },
      },
    });
    mocks.buildRegistrationOptions.mockResolvedValue({ challenge: "challenge-1" });
    mocks.buildAuthenticationOptions.mockResolvedValue({ challenge: "challenge-1" });
    mocks.verifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "credential-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    mocks.verifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    mocks.redisRateLimit.mockResolvedValue({ success: true });
    mocks.memoryRateLimit.mockReturnValue({ success: true });
  });

  it("creates a verified credential only through the owner-scoped admin boundary", async () => {
    const credentialInsert = query({
      data: { id: "passkey-1" },
      error: null,
    });
    useAdminQueries(
      query({
        data: { id: CEREMONY_ID, challenge: "challenge-1" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      credentialInsert,
      query({ data: null, error: null }),
    );

    const response = await register(registrationRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      verified: true,
      passkeyId: "passkey-1",
    });
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "webauthn_challenges",
      "webauthn_challenges",
      "user_passkeys",
      "user_auth_settings",
    ]);
    expect(credentialInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_1",
        credential_id: "credential-1",
        device_type: "platform",
      }),
    );
    expect(credentialInsert.insert).not.toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token_enc: expect.anything() }),
    );
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
  });

  it("refuses registration instead of falling back to the session client", async () => {
    mocks.createAdminClient.mockReturnValue(null);

    const response = await register(registrationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "PASSKEY_SERVICE_NOT_CONFIGURED",
    });
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
    expect(mocks.verifyRegistration).not.toHaveBeenCalled();
  });

  it("does not mint registration options when trusted challenge storage is unavailable", async () => {
    mocks.createAdminClient.mockReturnValue(null);
    const request = new NextRequest(
      "http://axis.test/api/auth/passkey/register?action=options",
    );

    const response = await registrationOptions(request);

    expect(response.status).toBe(503);
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
    expect(mocks.buildRegistrationOptions).not.toHaveBeenCalled();
  });

  it("rate-limits registration option creation before trusted database work", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });
    const request = new NextRequest(
      "http://axis.test/api/auth/passkey/register?action=options",
    );

    const response = await registrationOptions(request);

    expect(response.status).toBe(429);
    expect(mocks.redisRateLimit).toHaveBeenCalledWith(
      "user_1",
      20,
      "10 m",
      "axis:passkey-register-options",
    );
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.buildRegistrationOptions).not.toHaveBeenCalled();
  });

  it("rate-limits registration verification before consuming a ceremony", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });

    const response = await register(registrationRequest());

    expect(response.status).toBe(429);
    expect(mocks.redisRateLimit).toHaveBeenCalledWith(
      "user_1",
      10,
      "10 m",
      "axis:passkey-register-verify",
    );
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.verifyRegistration).not.toHaveBeenCalled();
  });

  it("returns an owner-scoped registration ceremony id without invalidating live ceremonies", async () => {
    const staleCleanup = query({ data: null, error: null });
    const challengeInsert = query({ data: { id: CEREMONY_ID }, error: null });
    useAdminQueries(
      query({ data: [{ credential_id: "existing-credential" }], error: null }),
      staleCleanup,
      challengeInsert,
    );
    const request = new NextRequest(
      "http://axis.test/api/auth/passkey/register?action=options",
    );

    const response = await registrationOptions(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      options: { challenge: "challenge-1" },
      ceremonyId: CEREMONY_ID,
    });
    expect(mocks.buildRegistrationOptions).toHaveBeenCalledWith(
      "user_1",
      "owner@example.test",
      ["existing-credential"],
    );
    expect(staleCleanup.lt).toHaveBeenCalledWith("expires_at", expect.any(String));
    expect(challengeInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_1",
        type: "registration",
        challenge: "challenge-1",
      }),
    );
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
  });

  it("consumes a registration challenge only once before credential creation", async () => {
    const challengeLookup = query({
      data: { id: CEREMONY_ID, challenge: "challenge-1" },
      error: null,
    });
    useAdminQueries(
      challengeLookup,
      query({ data: null, error: null }),
    );

    const response = await register(registrationRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "CHALLENGE_ALREADY_USED" });
    expect(mocks.verifyRegistration).not.toHaveBeenCalled();
    expect(challengeLookup.eq).toHaveBeenCalledWith("id", CEREMONY_ID);
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "webauthn_challenges",
      "webauthn_challenges",
    ]);
  });

  it("does not substitute another live registration challenge for the supplied ceremony id", async () => {
    const challengeLookup = query({ data: null, error: null });
    useAdminQueries(challengeLookup);

    const response = await register(registrationRequest(OTHER_CEREMONY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "CHALLENGE_EXPIRED" });
    expect(challengeLookup.eq).toHaveBeenCalledWith("id", OTHER_CEREMONY_ID);
    expect(mocks.verifyRegistration).not.toHaveBeenCalled();
  });

  it("lists passkeys only through the owner-scoped admin boundary", async () => {
    const credentialList = query({
      data: [{ id: "passkey-1", name: "Laptop" }],
      error: null,
    });
    useAdminQueries(credentialList);

    const response = await listPasskeys();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { id: "passkey-1", name: "Laptop" },
    ]);
    expect(credentialList.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
  });

  it("deletes only the authenticated owner's credential through admin", async () => {
    const credentialDelete = query({ data: { id: "passkey-1" }, error: null });
    useAdminQueries(
      credentialDelete,
      query({ data: null, error: null, count: 0 }),
      query({ data: null, error: null }),
    );
    const request = new NextRequest("http://axis.test/api/auth/passkey/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passkeyId: "passkey-1" }),
    });

    const response = await remove(request);

    expect(response.status).toBe(200);
    expect(credentialDelete.eq).toHaveBeenCalledWith("id", "passkey-1");
    expect(credentialDelete.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "user_passkeys",
      "user_passkeys",
      "user_auth_settings",
    ]);
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
  });

  it("refuses credential deletion without the admin boundary", async () => {
    mocks.createAdminClient.mockReturnValue(null);
    const request = new NextRequest("http://axis.test/api/auth/passkey/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passkeyId: "passkey-1" }),
    });

    const response = await remove(request);

    expect(response.status).toBe(503);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
  });

  it("mints and consumes a fresh one-time session without returning token material", async () => {
    const counterUpdate = query({ data: { id: "passkey-1" }, error: null });
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          user_id: "user_1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge-1" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      counterUpdate,
    );

    const response = await authenticate(authenticationRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      verified: true,
      userId: "user_1",
    });
    expect(body).not.toHaveProperty("refreshToken");
    expect(body).not.toHaveProperty("refresh_token");
    expect(body).not.toHaveProperty("token_hash");
    expect(body).not.toHaveProperty("hashed_token");
    expect(counterUpdate.eq).toHaveBeenCalledWith("id", "passkey-1");
    expect(counterUpdate.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(counterUpdate.eq).toHaveBeenCalledWith("counter", 1);
    expect(mocks.getUserById).toHaveBeenCalledWith("user_1");
    expect(mocks.generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "owner@example.test",
    });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "one-time-hash",
      type: "magiclink",
    });
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "user_passkeys",
      "webauthn_challenges",
      "webauthn_challenges",
      "user_passkeys",
    ]);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
  });

  it("rejects a one-time link generated for a different Supabase user", async () => {
    mocks.generateLink.mockResolvedValue({
      data: {
        properties: { hashed_token: "one-time-hash" },
        user: { id: "user_2" },
      },
      error: null,
    });
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          user_id: "user_1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge-1" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      query({ data: { id: "passkey-1" }, error: null }),
    );

    const response = await authenticate(authenticationRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "PASSKEY_SESSION_OWNER_MISMATCH",
      message: "Passkey authentication could not verify the session owner.",
    });
    expect(body).not.toHaveProperty("verified");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "validate_minted_session_owner",
        code: "PASSKEY_SESSION_OWNER_MISMATCH",
      }),
    );
  });

  it("clears and rejects a restored session owned by another user", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: {
        session: {
          user: { id: "user_2" },
        },
      },
      error: null,
    });
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          user_id: "user_1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge-1" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      query({ data: { id: "passkey-1" }, error: null }),
    );

    const response = await authenticate(authenticationRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "PASSKEY_SESSION_OWNER_MISMATCH",
      message: "Passkey authentication could not verify the session owner.",
    });
    expect(body).not.toHaveProperty("verified");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "validate_restored_session_owner",
        code: "PASSKEY_SESSION_OWNER_MISMATCH",
      }),
    );
  });

  it("does not return a session token when the credential counter CAS loses", async () => {
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          user_id: "user_1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge-1" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      query({ data: null, error: null }),
    );

    const response = await authenticate(authenticationRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "PASSKEY_COUNTER_CONFLICT",
    });
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("does not substitute another live authentication challenge for the supplied ceremony id", async () => {
    const challengeLookup = query({ data: null, error: null });
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          user_id: "user_1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      challengeLookup,
    );

    const response = await authenticate(authenticationRequest(OTHER_CEREMONY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "CHALLENGE_EXPIRED" });
    expect(challengeLookup.eq).toHaveBeenCalledWith("id", OTHER_CEREMONY_ID);
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });

  it("rejects a concurrently consumed authentication ceremony", async () => {
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          user_id: "user_1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge-1" },
        error: null,
      }),
      query({ data: null, error: null }),
    );

    const response = await authenticate(authenticationRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "CHALLENGE_ALREADY_USED",
    });
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });

  it("rate-limits authentication option creation before database work", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });
    const request = new NextRequest(
      "http://axis.test/api/auth/passkey/authenticate?action=options",
      { headers: { "x-forwarded-for": "203.0.113.10" } },
    );

    const response = await authenticationOptions(request);

    expect(response.status).toBe(429);
    expect(mocks.redisRateLimit).toHaveBeenCalledWith(
      "203.0.113.10",
      20,
      "10 m",
      "axis:passkey-options",
    );
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.buildAuthenticationOptions).not.toHaveBeenCalled();
  });

  it("returns a distinct authentication ceremony id", async () => {
    const challengeInsert = query({ data: { id: CEREMONY_ID }, error: null });
    useAdminQueries(
      query({ data: null, error: null }),
      challengeInsert,
    );
    const request = new NextRequest(
      "http://axis.test/api/auth/passkey/authenticate?action=options",
    );

    const response = await authenticationOptions(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      options: { challenge: "challenge-1" },
      ceremonyId: CEREMONY_ID,
    });
    expect(challengeInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        challenge: "challenge-1",
        type: "authentication",
      }),
    );
  });

  it("refuses pre-auth passkey login when the service role is unavailable", async () => {
    mocks.createAdminClient.mockReturnValue(null);

    const response = await authenticate(authenticationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "PASSKEY_SERVICE_NOT_CONFIGURED",
    });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it("does not mint login options without trusted challenge storage", async () => {
    mocks.createAdminClient.mockReturnValue(null);
    const request = new NextRequest(
      "http://axis.test/api/auth/passkey/authenticate?action=options",
    );

    const response = await authenticationOptions(request);

    expect(response.status).toBe(503);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.buildAuthenticationOptions).not.toHaveBeenCalled();
  });
});
