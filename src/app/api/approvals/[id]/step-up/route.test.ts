import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  admin: vi.fn(),
  consumeChallenge: vi.fn(),
  commitStepUp: vi.fn(),
  verifyAuthentication: vi.fn(),
  redisRateLimit: vi.fn(),
  memoryRateLimit: vi.fn(),
  capture: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin(),
}));
vi.mock("@/lib/webauthn/server", () => ({
  buildAuthenticationOptions: vi.fn(),
  verifyAuthentication: (...args: unknown[]) => mocks.verifyAuthentication(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: (...args: unknown[]) => mocks.redisRateLimit(...args),
  memoryRateLimit: (...args: unknown[]) => mocks.memoryRateLimit(...args),
}));
vi.mock("@/lib/security/approvalMutations", () => ({
  consumeApprovalAuthenticationChallenge: (...args: unknown[]) => mocks.consumeChallenge(...args),
  commitApprovalStepUp: (...args: unknown[]) => mocks.commitStepUp(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));
vi.mock("@/lib/observability/events", () => ({
  emitServerEvent: (...args: unknown[]) => mocks.emit(...args),
}));

import { GET, POST } from "./route";

const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function singleQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  return query;
}

function verifyRequest() {
  return new NextRequest(
    `http://axis.test/api/approvals/${APPROVAL_ID}/step-up?action=verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        response: {
          id: "credential_1",
          rawId: "credential_1",
          type: "public-key",
          response: {
            authenticatorData: "auth",
            clientDataJSON: "client",
            signature: "signature",
            userHandle: null,
          },
          clientExtensionResults: {},
          authenticatorAttachment: "platform",
        },
      }),
    },
  );
}

describe("approval WebAuthn step-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.admin.mockReturnValue({ rpc: vi.fn() });
    mocks.redisRateLimit.mockResolvedValue(null);
    mocks.memoryRateLimit.mockReturnValue({ success: true });
  });

  it("rate-limits option creation before storing another challenge", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });

    const response = await GET(
      new NextRequest(`http://axis.test/api/approvals/${APPROVAL_ID}/step-up?action=options`),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "TOO_MANY_ATTEMPTS" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("surfaces approval lookup errors instead of misclassifying them as not found", async () => {
    mocks.from.mockReturnValue(singleQuery({ data: null, error: { code: "DB_DOWN" } }));

    const response = await GET(
      new NextRequest(`http://axis.test/api/approvals/${APPROVAL_ID}/step-up?action=options`),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "APPROVAL_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("consumes the challenge once and commits counter plus approval stamp atomically", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "approvals") {
        return singleQuery({
          data: {
            id: APPROVAL_ID,
            requirement: "approval_step_up",
            status: "pending",
            step_up_verified_at: null,
          },
          error: null,
        });
      }
      return singleQuery({
        data: {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          credential_id: "credential_1",
          credential_public_key: "public-key",
          counter: 4,
          transports: ["internal"],
        },
        error: null,
      });
    });
    mocks.consumeChallenge.mockResolvedValue({
      ok: true,
      challengeId: "challenge_1",
      challenge: "opaque-challenge",
    });
    mocks.verifyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });
    mocks.commitStepUp.mockResolvedValue({
      ok: true,
      approval: {
        id: APPROVAL_ID,
        action_class: "FINANCIAL_EXECUTION",
        status: "pending",
        step_up_verified_at: "2026-07-16T00:00:00.000Z",
      },
    });

    const response = await POST(
      verifyRequest(),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.consumeChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }), expect.anything());
    expect(mocks.commitStepUp).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: APPROVAL_ID,
      expectedApprovalStatus: "pending",
      expectedCounter: 4,
      newCounter: 5,
    }), expect.anything());
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it("fails closed when challenge consumption cannot be committed", async () => {
    mocks.from.mockImplementation((table: string) => table === "approvals"
      ? singleQuery({
        data: {
          id: APPROVAL_ID,
          requirement: "approval_step_up",
          status: "pending",
          step_up_verified_at: null,
        },
        error: null,
      })
      : singleQuery({
        data: {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          credential_id: "credential_1",
          credential_public_key: "public-key",
          counter: 0,
          transports: [],
        },
        error: null,
      }));
    mocks.consumeChallenge.mockResolvedValue({ ok: false, code: "RPC_FAILED" });

    const response = await POST(
      verifyRequest(),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "CHALLENGE_CONSUME_FAILED" });
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
  });
});
