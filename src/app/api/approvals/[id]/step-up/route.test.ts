import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  sessionFrom: vi.fn(),
  adminFrom: vi.fn(),
  createAdminClient: vi.fn(),
  redisRateLimit: vi.fn(),
  memoryRateLimit: vi.fn(),
  buildAuthenticationOptions: vi.fn(),
  verifyAuthentication: vi.fn(),
  emitServerEvent: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.sessionFrom,
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: mocks.redisRateLimit,
  memoryRateLimit: mocks.memoryRateLimit,
}));
vi.mock("@/lib/webauthn/server", () => ({
  buildAuthenticationOptions: mocks.buildAuthenticationOptions,
  verifyAuthentication: mocks.verifyAuthentication,
}));
vi.mock("@/lib/observability/events", () => ({
  emitServerEvent: mocks.emitServerEvent,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const CEREMONY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CEREMONY_ID = "44444444-4444-4444-8444-444444444444";
const context = { params: Promise.resolve({ id: APPROVAL_ID }) };

function request(ceremonyId = CEREMONY_ID) {
  return new NextRequest(
    `http://axis.test/api/approvals/${APPROVAL_ID}/step-up?action=verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response: {
          id: "credential-1",
          rawId: "credential-1",
          response: {
            authenticatorData: "data",
            clientDataJSON: "client",
            signature: "signature",
          },
          type: "public-key",
          clientExtensionResults: {},
        },
        ceremonyId,
      }),
    },
  );
}

function optionsRequest() {
  return new NextRequest(
    `http://axis.test/api/approvals/${APPROVAL_ID}/step-up?action=options`,
  );
}

function approval(status = "approved") {
  return {
    id: APPROVAL_ID,
    requirement: "approval_step_up",
    status,
    step_up_verified_at: null,
  };
}

function query(result: { data: unknown; error: unknown }) {
  const value: Record<string, unknown> = {};
  for (const method of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "in",
    "gt",
    "lt",
    "order",
    "limit",
  ]) {
    value[method] = vi.fn(() => value);
  }
  value.maybeSingle = vi.fn(async () => result);
  value.single = vi.fn(async () => result);
  value.then = (
    resolve: (result: { data: unknown; error: unknown }) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return value;
}

function useSessionQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.sessionFrom.mockImplementation(() => queue.shift());
}

function useAdminQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.adminFrom.mockImplementation(() => queue.shift());
}

describe("/api/approvals/[id]/step-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
    mocks.redisRateLimit.mockResolvedValue({ success: true });
    mocks.memoryRateLimit.mockReturnValue({ success: true });
    mocks.createAdminClient.mockReturnValue({ from: mocks.adminFrom });
    mocks.buildAuthenticationOptions.mockResolvedValue({ challenge: "challenge" });
    mocks.verifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
  });

  it("uses admin passkey reads and returns an exact ceremony id", async () => {
    const passkeyList = query({
      data: [{ credential_id: "credential-1" }],
      error: null,
    });
    const challengeInsert = query({
      data: { id: CEREMONY_ID },
      error: null,
    });
    useSessionQueries(query({ data: approval(), error: null }));
    useAdminQueries(
      passkeyList,
      query({ data: null, error: null }),
      challengeInsert,
    );

    const response = await GET(optionsRequest(), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      options: { challenge: "challenge" },
      ceremonyId: CEREMONY_ID,
    });
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "user_passkeys",
      "webauthn_challenges",
      "webauthn_challenges",
    ]);
    expect(mocks.buildAuthenticationOptions).toHaveBeenCalledWith(["credential-1"]);
  });

  it("rate-limits option creation before reading approval or credential state", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });

    const response = await GET(optionsRequest(), context);

    expect(response.status).toBe(429);
    expect(mocks.redisRateLimit).toHaveBeenCalledWith(
      "user_1",
      20,
      "10 m",
      "axis:approval-step-up-options",
    );
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("treats an executing approval as in-flight before touching claim state", async () => {
    useSessionQueries(query({ data: approval("executing"), error: null }));

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "APPROVAL_IN_FLIGHT",
      status: "executing",
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("rate-limits verification before reading approval or credential state", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });

    const response = await POST(request(), context);

    expect(response.status).toBe(429);
    expect(mocks.redisRateLimit).toHaveBeenCalledWith(
      "user_1",
      10,
      "10 m",
      "axis:approval-step-up-verify",
    );
    expect(mocks.sessionFrom).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("requires the trusted admin boundary for challenge and approval writes", async () => {
    useSessionQueries(query({ data: approval(), error: null }));
    mocks.createAdminClient.mockReturnValue(null);

    const response = await POST(request(), context);

    expect(response.status).toBe(503);
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it("allows only one verifier to consume a challenge", async () => {
    useSessionQueries(query({ data: approval(), error: null }));
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge" },
        error: null,
      }),
      query({ data: null, error: null }),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "CHALLENGE_ALREADY_USED" });
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it("does not substitute another approval challenge for the supplied ceremony id", async () => {
    const challengeLookup = query({ data: null, error: null });
    useSessionQueries(query({ data: approval(), error: null }));
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      challengeLookup,
    );

    const response = await POST(request(OTHER_CEREMONY_ID), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "CHALLENGE_EXPIRED" });
    expect(challengeLookup.eq).toHaveBeenCalledWith("id", OTHER_CEREMONY_ID);
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });

  it("persists the passkey counter before stamping the approval", async () => {
    const counterUpdate = query({ data: { id: "passkey-1" }, error: null });
    const approvalUpdate = query({
      data: {
        id: APPROVAL_ID,
        step_up_verified_at: "2026-07-16T12:00:00.000Z",
      },
      error: null,
    });
    useSessionQueries(query({ data: approval(), error: null }));
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      counterUpdate,
      approvalUpdate,
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "user_passkeys",
      "webauthn_challenges",
      "webauthn_challenges",
      "user_passkeys",
      "approvals",
    ]);
    expect(mocks.emitServerEvent).toHaveBeenCalledWith(
      "approval.step_up_verified",
      { approvalId: APPROVAL_ID },
    );
  });

  it("rejects a stale passkey counter before stamping the approval", async () => {
    const counterUpdate = query({ data: null, error: null });
    useSessionQueries(query({ data: approval(), error: null }));
    useAdminQueries(
      query({
        data: {
          id: "passkey-1",
          credential_id: "credential-1",
          credential_public_key: "public-key",
          counter: 1,
          transports: [],
        },
        error: null,
      }),
      query({
        data: { id: CEREMONY_ID, challenge: "challenge" },
        error: null,
      }),
      query({ data: { id: CEREMONY_ID }, error: null }),
      counterUpdate,
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "PASSKEY_COUNTER_CONFLICT" });
    expect(mocks.adminFrom.mock.calls.map(([table]) => table)).toEqual([
      "user_passkeys",
      "webauthn_challenges",
      "webauthn_challenges",
      "user_passkeys",
    ]);
    expect(mocks.emitServerEvent).not.toHaveBeenCalled();
  });
});
