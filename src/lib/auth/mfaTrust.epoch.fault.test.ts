import { describe, expect, it } from "vitest";
import { issueMfaTrustToken, verifyMfaTrustToken } from "@/lib/auth/mfaTrust";

describe("remembered-device trust epoch", () => {
  it("rejects a correctly signed token when the server-side epoch has rotated", async () => {
    const issued = await issueMfaTrustToken({ secret: "test-secret", userId: "user-1", factorId: "factor-1", trustEpoch: 4, nowMs: 1_000, windowDays: 1 });
    await expect(verifyMfaTrustToken({ secret: "test-secret", token: issued?.token, userId: "user-1", trustEpoch: 5, nowMs: 2_000 })).resolves.toEqual({ trusted: false, reason: "wrong_epoch" });
  });
});
