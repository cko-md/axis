import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./captureRouteError", () => ({ captureRouteError: vi.fn() }));

import { captureRouteError } from "./captureRouteError";
import { redactRouteError } from "./redactRouteError";

describe("redactRouteError", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never leaks the raw error message to the client", async () => {
    const res = redactRouteError(
      new Error('duplicate key value violates unique constraint "fund_holdings_pkey"'),
      { route: "fund/holdings", area: "fund" },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("unique constraint");
  });

  it("uses the provided safe message + status and captures the real error server-side", async () => {
    const err = new Error("raw provider detail that must not reach the client");
    const res = redactRouteError(err, {
      route: "auth/mfa/verify",
      area: "auth",
      status: 400,
      message: "MFA verification failed",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "MFA verification failed" });
    expect(captureRouteError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ route: "auth/mfa/verify", status: 400, area: "auth" }),
    );
  });
});
