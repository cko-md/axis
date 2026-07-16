import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("retired passkey session sync route", () => {
  it("rejects the legacy token-sync contract without returning secrets", async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body).toEqual({ error: "PASSKEY_SESSION_SYNC_RETIRED" });
    expect(JSON.stringify(body)).not.toMatch(/refresh.?token|access.?token|token_hash/i);
  });
});
