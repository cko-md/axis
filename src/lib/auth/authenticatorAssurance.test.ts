import { describe, expect, it, vi } from "vitest";
import {
  isMfaBootstrapApiPath,
  requireAuthenticatorAssurance,
} from "./authenticatorAssurance";

function client(
  data: { currentLevel: string | null; nextLevel: string | null } | null,
  error: unknown = null,
) {
  return {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data, error }),
      },
    },
  };
}

describe("authenticator assurance", () => {
  it("requires MFA when the session can elevate from aal1 to aal2", async () => {
    await expect(
      requireAuthenticatorAssurance(
        client({ currentLevel: "aal1", nextLevel: "aal2" }),
      ),
    ).resolves.toBe("mfa_required");
  });

  it("accepts sessions that are already aal2 or have no enrolled second factor", async () => {
    await expect(
      requireAuthenticatorAssurance(
        client({ currentLevel: "aal2", nextLevel: "aal2" }),
      ),
    ).resolves.toBe("satisfied");
    await expect(
      requireAuthenticatorAssurance(
        client({ currentLevel: "aal1", nextLevel: "aal1" }),
      ),
    ).resolves.toBe("satisfied");
  });

  it("fails closed on errors and unexpected assurance combinations", async () => {
    await expect(
      requireAuthenticatorAssurance(client(null, new Error("unavailable"))),
    ).resolves.toBe("unavailable");
    await expect(
      requireAuthenticatorAssurance(
        client({ currentLevel: null, nextLevel: "aal2" }),
      ),
    ).resolves.toBe("unavailable");
  });

  it("allows only challenge and verify through the pre-AAL2 API boundary", () => {
    expect(isMfaBootstrapApiPath("/api/auth/mfa/challenge")).toBe(true);
    expect(isMfaBootstrapApiPath("/api/auth/mfa/verify")).toBe(true);
    expect(isMfaBootstrapApiPath("/api/auth/mfa/unenroll")).toBe(false);
    expect(isMfaBootstrapApiPath("/api/approvals")).toBe(false);
    expect(isMfaBootstrapApiPath("/api/routines")).toBe(false);
  });
});
