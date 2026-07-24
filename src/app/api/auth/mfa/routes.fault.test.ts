import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  admit: vi.fn(),
  assurance: vi.fn(),
  listFactors: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  upsert: vi.fn(),
  rotateEpoch: vi.fn(),
  readEpoch: vi.fn(),
  issueTrust: vi.fn(),
  verifyTrust: vi.fn(),
  redact: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mocks.getUser,
      mfa: {
        listFactors: mocks.listFactors,
        challenge: mocks.challenge,
        verify: mocks.verify,
        enroll: mocks.enroll,
        unenroll: mocks.unenroll,
      },
    },
    from: vi.fn(() => ({ upsert: mocks.upsert })),
  }),
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    mfaChallenge: {
      name: "mfa-challenge",
      limit: 10,
      window: "5 m",
      protected: true,
    },
    mfaVerify: {
      name: "mfa-verify",
      limit: 5,
      window: "5 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));
vi.mock("@/lib/auth/authenticatorAssurance", () => ({
  requireAuthenticatorAssurance: (...args: unknown[]) =>
    mocks.assurance(...args),
}));
vi.mock("@/lib/auth/securityState", () => ({
  rotateMfaTrustEpoch: (...args: unknown[]) => mocks.rotateEpoch(...args),
  readMfaTrustEpoch: (...args: unknown[]) => mocks.readEpoch(...args),
}));
vi.mock("@/lib/auth/mfaTrust", () => ({
  MFA_TRUST_COOKIE: "axis_mfa_trust",
  issueMfaTrustToken: (...args: unknown[]) => mocks.issueTrust(...args),
  verifyMfaTrustToken: (...args: unknown[]) => mocks.verifyTrust(...args),
  isMfaTrustFactorCurrent: (
    verdict: { trusted?: boolean; payload?: { fid?: string } },
    factors: Array<{ id: string; status: string }>,
  ) => Boolean(
    verdict.trusted
    && factors.some(
      (factor) =>
        factor.id === verdict.payload?.fid
        && factor.status === "verified",
    ),
  ),
  resolveTrustWindowDays: () => 30,
}));
vi.mock("@/lib/observability/redactRouteError", () => ({
  redactRouteError: (...args: unknown[]) => mocks.redact(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { POST as challengeMfa } from "./challenge/route";
import { POST as enrollMfa } from "./enroll/route";
import {
  GET as getTrustDevice,
  POST as trustDevice,
} from "./trust-device/route";
import { DELETE as unenrollMfa } from "./unenroll/route";
import { POST as verifyMfa } from "./verify/route";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERIFIED_FACTOR = {
  id: "verified-factor",
  status: "verified",
  factor_type: "totp",
};
const UNVERIFIED_FACTOR = {
  id: "unverified-factor",
  status: "unverified",
  factor_type: "totp",
};

function jsonRequest(pathname: string, method: "POST" | "DELETE", body: unknown) {
  return new NextRequest(`https://axis.test${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("MFA route fault boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: USER_ID } },
      error: null,
    });
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mocks.assurance.mockResolvedValue("mfa_required");
    mocks.listFactors.mockResolvedValue({
      data: { all: [VERIFIED_FACTOR] },
      error: null,
    });
    mocks.challenge.mockResolvedValue({
      data: { id: "challenge-1" },
      error: null,
    });
    mocks.verify.mockResolvedValue({ error: null });
    mocks.enroll.mockResolvedValue({
      data: {
        id: UNVERIFIED_FACTOR.id,
        totp: {
          qr_code: "data:image/svg+xml;base64,test",
          secret: "secret",
          uri: "otpauth://test",
        },
      },
      error: null,
    });
    mocks.unenroll.mockResolvedValue({ error: null });
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.rotateEpoch.mockResolvedValue(2);
    mocks.readEpoch.mockResolvedValue(2);
    mocks.issueTrust.mockResolvedValue(null);
    mocks.verifyTrust.mockResolvedValue({ trusted: false, reason: "missing" });
    mocks.redact.mockImplementation(
      (_error: unknown, context: { status: number }) =>
        Response.json(
          { error: "REDACTED_PROVIDER_ERROR" },
          { status: context.status },
        ),
    );
  });

  it("admits the normal no-factor login challenge using an owned verified factor", async () => {
    const response = await challengeMfa(
      jsonRequest("/api/auth/mfa/challenge", "POST", {}),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      required: true,
      challengeId: "challenge-1",
      factorId: VERIFIED_FACTOR.id,
    });
    expect(mocks.challenge).toHaveBeenCalledWith({
      factorId: VERIFIED_FACTOR.id,
    });
  });

  it("allows an explicit first unverified factor only for initial enrollment", async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [UNVERIFIED_FACTOR] },
      error: null,
    });

    const response = await challengeMfa(
      jsonRequest("/api/auth/mfa/challenge", "POST", {
        factorId: UNVERIFIED_FACTOR.id,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.challenge).toHaveBeenCalledWith({
      factorId: UNVERIFIED_FACTOR.id,
    });
  });

  it("denies an unverified enrollment factor when a compromised AAL1 session already has a verified factor", async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [VERIFIED_FACTOR, UNVERIFIED_FACTOR] },
      error: null,
    });

    const response = await challengeMfa(
      jsonRequest("/api/auth/mfa/challenge", "POST", {
        factorId: UNVERIFIED_FACTOR.id,
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it("runs verification admission before attempting a provider verification", async () => {
    mocks.admit.mockResolvedValue({
      kind: "unavailable",
      reason: "backend",
    });

    const response = await verifyMfa(
      jsonRequest("/api/auth/mfa/verify", "POST", {
        factorId: VERIFIED_FACTOR.id,
        challengeId: "challenge-1",
        code: "123456",
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.listFactors).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists verified MFA settings before returning success", async () => {
    const response = await verifyMfa(
      jsonRequest("/api/auth/mfa/verify", "POST", {
        factorId: VERIFIED_FACTOR.id,
        challengeId: "challenge-1",
        code: "123456",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        twofa_enabled: true,
        twofa_method: "totp",
      }),
      { onConflict: "user_id" },
    );
    expect(mocks.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("fails closed before verification when owner-factor lookup is unavailable", async () => {
    mocks.listFactors.mockResolvedValue({
      data: null,
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await verifyMfa(
      jsonRequest("/api/auth/mfa/verify", "POST", {
        factorId: VERIFIED_FACTOR.id,
        challengeId: "challenge-1",
        code: "123456",
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not falsely report verification failure after a post-verify settings write fails", async () => {
    mocks.upsert.mockResolvedValue({
      error: { code: "AUTH_SETTINGS_DOWN" },
    });

    const response = await verifyMfa(
      jsonRequest("/api/auth/mfa/verify", "POST", {
        factorId: VERIFIED_FACTOR.id,
        challengeId: "challenge-1",
        code: "123456",
      }),
    );

    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      verified: true,
      settings_sync: "pending",
    });
  });

  it("rotates the trust epoch before enrolling a new factor", async () => {
    const response = await enrollMfa(
      jsonRequest("/api/auth/mfa/enroll", "POST", { method: "totp" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enroll.mock.invocationCallOrder[0],
    );
  });

  it("does not expose raw MFA enrollment provider errors and classifies backend failure as 503", async () => {
    const sensitive =
      "provider failed email=user@example.test token=server-secret";
    mocks.enroll.mockResolvedValue({
      data: null,
      error: { message: sensitive, status: 500 },
    });

    const response = await enrollMfa(
      jsonRequest("/api/auth/mfa/enroll", "POST", { method: "totp" }),
    );
    const responseBody = await response.text();

    expect(response.status).toBe(503);
    expect(responseBody).not.toContain(sensitive);
  });

  it.each([
    ["challenge", () => challengeMfa(
      jsonRequest("/api/auth/mfa/challenge", "POST", {
        padding: "x".repeat(70_000),
      }),
    )],
    ["enroll", () => enrollMfa(
      jsonRequest("/api/auth/mfa/enroll", "POST", {
        method: "totp",
        padding: "x".repeat(70_000),
      }),
    )],
    ["verify", () => verifyMfa(
      jsonRequest("/api/auth/mfa/verify", "POST", {
        factorId: VERIFIED_FACTOR.id,
        challengeId: "challenge-1",
        code: "123456",
        padding: "x".repeat(70_000),
      }),
    )],
    ["unenroll", () => unenrollMfa(
      jsonRequest("/api/auth/mfa/unenroll", "DELETE", {
        factorId: VERIFIED_FACTOR.id,
        padding: "x".repeat(70_000),
      }),
    )],
  ])("rejects an oversized %s body before provider or security mutation", async (_name, invoke) => {
    const response = await invoke();

    expect(response.status).toBe(413);
    expect(mocks.challenge).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(mocks.unenroll).not.toHaveBeenCalled();
    expect(mocks.rotateEpoch).not.toHaveBeenCalled();
  });

  it("rejects an explicit factor ID not present in the caller-owned factor list", async () => {
    const response = await challengeMfa(
      jsonRequest("/api/auth/mfa/challenge", "POST", {
        factorId: "not-owned-factor",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it.each([
    ["verify", () => {
      mocks.verify.mockResolvedValue({
        error: { message: "provider network failure", status: 500 },
      });
      return verifyMfa(
        jsonRequest("/api/auth/mfa/verify", "POST", {
          factorId: VERIFIED_FACTOR.id,
          challengeId: "challenge-1",
          code: "123456",
        }),
      );
    }],
    ["unenroll", () => {
      mocks.unenroll.mockResolvedValue({
        error: { message: "provider network failure", status: 500 },
      });
      return unenrollMfa(
        jsonRequest("/api/auth/mfa/unenroll", "DELETE", {
          factorId: VERIFIED_FACTOR.id,
        }),
      );
    }],
  ])("classifies %s provider backend failure as safe 503", async (_name, invoke) => {
    const response = await invoke();

    expect(response.status).toBe(503);
    expect(mocks.redact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 503 }),
    );
  });

  it("rotates the trust epoch before unenrolling a factor", async () => {
    const response = await unenrollMfa(
      jsonRequest("/api/auth/mfa/unenroll", "DELETE", {
        factorId: VERIFIED_FACTOR.id,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.unenroll.mock.invocationCallOrder[0],
    );
  });

  it("does not overwrite settings with two-factor disabled when the post-unenroll factor projection fails", async () => {
    mocks.listFactors.mockResolvedValue({
      data: null,
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await unenrollMfa(
      jsonRequest("/api/auth/mfa/unenroll", "DELETE", {
        factorId: VERIFIED_FACTOR.id,
      }),
    );

    expect(mocks.unenroll).toHaveBeenCalledOnce();
    expect(mocks.upsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      settings_sync: "pending",
    });
  });

  it.each([
    ["enroll", () => enrollMfa(
      jsonRequest("/api/auth/mfa/enroll", "POST", { method: "totp" }),
    )],
    ["unenroll", () => unenrollMfa(
      jsonRequest("/api/auth/mfa/unenroll", "DELETE", {
        factorId: VERIFIED_FACTOR.id,
      }),
    )],
  ])("maps %s authentication backend failures to 503 rather than 401", async (_name, invoke) => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await invoke();

    expect(response.status).toBe(503);
  });

  it.each([
    ["trust-device read", () => getTrustDevice(
      new NextRequest("https://axis.test/api/auth/mfa/trust-device"),
    )],
    ["trust-device write", () => trustDevice()],
  ])("maps %s authentication backend failures to 503 rather than 401", async (_name, invoke) => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await invoke();

    expect(response.status).toBe(503);
  });

  it("maps trust-device assurance backend failure to 503 rather than a false MFA denial", async () => {
    mocks.assurance.mockResolvedValue("unavailable");

    const response = await trustDevice();

    expect(response.status).toBe(503);
    expect(mocks.listFactors).not.toHaveBeenCalled();
  });

  it("runs canonical admission before trust-device assurance or factor lookup", async () => {
    mocks.admit.mockResolvedValue({
      kind: "unavailable",
      reason: "backend",
    });

    const response = await trustDevice();

    expect(response.status).toBe(503);
    expect(mocks.assurance).not.toHaveBeenCalled();
    expect(mocks.listFactors).not.toHaveBeenCalled();
  });

  it("maps trust-device factor lookup failure to 503 rather than claiming no factor exists", async () => {
    mocks.assurance.mockResolvedValue("satisfied");
    mocks.listFactors.mockResolvedValue({
      data: null,
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await trustDevice();

    expect(response.status).toBe(503);
  });

  it("catches a thrown trust-device factor lookup and reports an observable 503", async () => {
    mocks.assurance.mockResolvedValue("satisfied");
    mocks.listFactors.mockRejectedValue(new Error("sensitive provider failure"));

    const response = await trustDevice();

    expect(response.status).toBe(503);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        code: "AUTH_BACKEND_UNAVAILABLE",
        operation: "load_factors",
      }),
    );
  });

  it("revokes remembered trust when the bound factor was replaced out of band", async () => {
    mocks.verifyTrust.mockResolvedValue({
      trusted: true,
      payload: { fid: "replaced-factor" },
    });
    mocks.listFactors.mockResolvedValue({
      data: { all: [VERIFIED_FACTOR] },
      error: null,
    });

    const response = await getTrustDevice(
      new NextRequest("https://axis.test/api/auth/mfa/trust-device"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      trusted: false,
      reason: "wrong_factor",
    });
    expect(mocks.listFactors).toHaveBeenCalledOnce();
  });
});
