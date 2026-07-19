import { describe, expect, it } from "vitest";
import {
  DEFAULT_MFA_TRUST_WINDOW_DAYS,
  MAX_MFA_TRUST_WINDOW_DAYS,
  issueMfaTrustToken,
  resolveTrustWindowDays,
  verifyMfaTrustToken,
} from "@/lib/auth/mfaTrust";

const SECRET = "test-secret-value-do-not-use-in-production";
const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function mint(overrides: Partial<Parameters<typeof issueMfaTrustToken>[0]> = {}) {
  const issued = await issueMfaTrustToken({
    secret: SECRET,
    userId: "user-1",
    factorId: "factor-1",
    nowMs: NOW,
    windowDays: 30,
    ...overrides,
  });
  return issued;
}

describe("mfa trust window", () => {
  it("accepts a freshly minted token for the same user", async () => {
    const issued = await mint();
    expect(issued).not.toBeNull();

    const verdict = await verifyMfaTrustToken({
      secret: SECRET,
      token: issued!.token,
      userId: "user-1",
      nowMs: NOW + DAY,
    });
    expect(verdict.trusted).toBe(true);
  });

  it("reports a max-age matching the requested window", async () => {
    const issued = await mint({ windowDays: 30 });
    expect(issued!.maxAgeSeconds).toBe(30 * 24 * 60 * 60);
  });

  // Fail-closed is the whole security posture of this module: every negative
  // path below must deny, never grant.
  it("denies when no secret is configured", async () => {
    const verdict = await verifyMfaTrustToken({
      secret: undefined,
      token: "anything",
      userId: "user-1",
      nowMs: NOW,
    });
    expect(verdict).toEqual({ trusted: false, reason: "not_configured" });
  });

  it("mints nothing when no secret is configured", async () => {
    await expect(mint({ secret: undefined })).resolves.toBeNull();
  });

  it("denies when no token is presented", async () => {
    const verdict = await verifyMfaTrustToken({
      secret: SECRET,
      token: undefined,
      userId: "user-1",
      nowMs: NOW,
    });
    expect(verdict).toEqual({ trusted: false, reason: "absent" });
  });

  it("denies a token signed with a different secret", async () => {
    const issued = await mint();
    const verdict = await verifyMfaTrustToken({
      secret: "a-different-secret",
      token: issued!.token,
      userId: "user-1",
      nowMs: NOW,
    });
    expect(verdict).toEqual({ trusted: false, reason: "bad_signature" });
  });

  it("denies a token whose payload was tampered with", async () => {
    const issued = await mint();
    const [, signature] = issued!.token.split(".");
    const forged = btoa(
      JSON.stringify({ sub: "user-2", fid: "factor-1", iat: NOW, exp: NOW + DAY }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const verdict = await verifyMfaTrustToken({
      secret: SECRET,
      token: `${forged}.${signature}`,
      userId: "user-2",
      nowMs: NOW,
    });
    expect(verdict).toEqual({ trusted: false, reason: "bad_signature" });
  });

  it("denies once the window has elapsed", async () => {
    const issued = await mint({ windowDays: 30 });
    const verdict = await verifyMfaTrustToken({
      secret: SECRET,
      token: issued!.token,
      userId: "user-1",
      nowMs: NOW + 31 * DAY,
    });
    expect(verdict).toEqual({ trusted: false, reason: "expired" });
  });

  it("denies a token minted for a different account", async () => {
    const issued = await mint({ userId: "user-1" });
    const verdict = await verifyMfaTrustToken({
      secret: SECRET,
      token: issued!.token,
      userId: "someone-else",
      nowMs: NOW,
    });
    expect(verdict).toEqual({ trusted: false, reason: "wrong_user" });
  });

  it("denies malformed tokens without throwing", async () => {
    for (const token of ["", "nodot", "a.b.c", "!!!.???", "."]) {
      const verdict = await verifyMfaTrustToken({
        secret: SECRET,
        token,
        userId: "user-1",
        nowMs: NOW,
      });
      expect(verdict.trusted).toBe(false);
    }
  });

  it("carries the proving factor so re-enrollment can invalidate trust", async () => {
    const issued = await mint({ factorId: "factor-abc" });
    const verdict = await verifyMfaTrustToken({
      secret: SECRET,
      token: issued!.token,
      userId: "user-1",
      nowMs: NOW,
    });
    expect(verdict.trusted && verdict.payload.fid).toBe("factor-abc");
  });
});

describe("resolveTrustWindowDays", () => {
  it("defaults when unset or unparseable", () => {
    expect(resolveTrustWindowDays(undefined)).toBe(DEFAULT_MFA_TRUST_WINDOW_DAYS);
    expect(resolveTrustWindowDays("")).toBe(DEFAULT_MFA_TRUST_WINDOW_DAYS);
    expect(resolveTrustWindowDays("not-a-number")).toBe(DEFAULT_MFA_TRUST_WINDOW_DAYS);
  });

  it("rejects zero and negative windows rather than disabling the challenge", () => {
    expect(resolveTrustWindowDays("0")).toBe(DEFAULT_MFA_TRUST_WINDOW_DAYS);
    expect(resolveTrustWindowDays("-5")).toBe(DEFAULT_MFA_TRUST_WINDOW_DAYS);
  });

  it("caps an over-long window instead of honoring it", () => {
    expect(resolveTrustWindowDays("3650")).toBe(MAX_MFA_TRUST_WINDOW_DAYS);
  });

  it("honors a sane configured window", () => {
    expect(resolveTrustWindowDays("7")).toBe(7);
  });
});

describe("structural decoupling from the financial safety kernel", () => {
  // The session-level trust window and per-approval step-up are deliberately
  // separate mechanisms. FINANCIAL_EXECUTION and DESTRUCTIVE_ADMIN require a
  // fresh WebAuthn ceremony per approval; remembering a device must never
  // shorten or satisfy that. The cheapest durable way to hold that line is to
  // assert the security modules never import assurance or trust at all.
  const SECURITY_SOURCES = [
    "src/lib/security/actionPolicy.ts",
    "src/lib/security/approvalRequest.ts",
    "src/lib/security/approvalPersistence.ts",
  ];

  it.each(SECURITY_SOURCES)("%s never consults session assurance or device trust", async (relativePath) => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");

    for (const forbidden of ["mfaTrust", "authenticatorAssurance", "aal2", "MFA_TRUST"]) {
      expect(
        source.includes(forbidden),
        `${relativePath} references ${forbidden}; step-up must stay independent of session MFA`,
      ).toBe(false);
    }
  });
});
