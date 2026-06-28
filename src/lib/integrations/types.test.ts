import { describe, it, expect } from "vitest";
import {
  ok,
  fail,
  makeError,
  codeFromStatus,
  failFromStatus,
  failFromException,
  type Result,
} from "./types";

describe("ok()", () => {
  it("wraps a value in a successful Result", () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, data: 42 });
  });

  it("works with null data", () => {
    const r = ok(null);
    expect(r).toEqual({ ok: true, data: null });
  });

  it("works with complex data", () => {
    const r = ok({ messages: ["a", "b"], count: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.messages).toEqual(["a", "b"]);
  });
});

describe("fail()", () => {
  it("returns a failing Result with structured error", () => {
    const r = fail("auth_expired", "Token missing");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("auth_expired");
      expect(r.error.message).toBe("Token missing");
      expect(r.error.retryable).toBe(false);
    }
  });

  it("includes provider and transport when provided", () => {
    const r = fail("provider_error", "Bad response", {
      provider: "gmail",
      transport: "direct",
    });
    if (!r.ok) {
      expect(r.error.provider).toBe("gmail");
      expect(r.error.transport).toBe("direct");
    }
  });

  it("includes HTTP status when provided", () => {
    const r = fail("rate_limited", "Slow down", { status: 429 });
    if (!r.ok) {
      expect(r.error.status).toBe(429);
    }
  });

  it("allows overriding retryable", () => {
    const r = fail("auth_expired", "Expired", { retryable: true });
    if (!r.ok) {
      expect(r.error.retryable).toBe(true);
    }
  });

  it("defaults retryable per error code", () => {
    // rate_limited defaults retryable=true
    const r1 = fail("rate_limited", "Slow");
    if (!r1.ok) expect(r1.error.retryable).toBe(true);

    // auth_expired defaults retryable=false
    const r2 = fail("auth_expired", "Expired");
    if (!r2.ok) expect(r2.error.retryable).toBe(false);

    // network defaults retryable=true
    const r3 = fail("network", "Timeout");
    if (!r3.ok) expect(r3.error.retryable).toBe(true);

    // unknown defaults retryable=true
    const r4 = fail("unknown", "???");
    if (!r4.ok) expect(r4.error.retryable).toBe(true);

    // not_found defaults retryable=false
    const r5 = fail("not_found", "Gone");
    if (!r5.ok) expect(r5.error.retryable).toBe(false);
  });
});

describe("makeError()", () => {
  it("builds a complete IntegrationError", () => {
    const err = makeError("invalid_request", "Bad input", {
      provider: "outlook",
      transport: "composio",
      status: 400,
    });
    expect(err).toEqual({
      code: "invalid_request",
      message: "Bad input",
      retryable: false,
      provider: "outlook",
      transport: "composio",
      status: 400,
    });
  });

  it("omits undefined optional fields", () => {
    const err = makeError("provider_error", "Oops");
    expect(err).toEqual({
      code: "provider_error",
      message: "Oops",
      retryable: true,
    });
    expect("provider" in err).toBe(false);
    expect("transport" in err).toBe(false);
    expect("status" in err).toBe(false);
  });
});

describe("codeFromStatus()", () => {
  it("maps 401 to auth_expired", () => {
    expect(codeFromStatus(401)).toBe("auth_expired");
  });

  it("maps 403 to auth_expired", () => {
    expect(codeFromStatus(403)).toBe("auth_expired");
  });

  it("maps 404 to not_found", () => {
    expect(codeFromStatus(404)).toBe("not_found");
  });

  it("maps 429 to rate_limited", () => {
    expect(codeFromStatus(429)).toBe("rate_limited");
  });

  it("maps 400 to invalid_request", () => {
    expect(codeFromStatus(400)).toBe("invalid_request");
  });

  it("maps 422 to invalid_request", () => {
    expect(codeFromStatus(422)).toBe("invalid_request");
  });

  it("maps 500 to provider_error", () => {
    expect(codeFromStatus(500)).toBe("provider_error");
  });

  it("maps 502 to provider_error", () => {
    expect(codeFromStatus(502)).toBe("provider_error");
  });

  it("maps 503 to provider_error", () => {
    expect(codeFromStatus(503)).toBe("provider_error");
  });

  it("maps 200 to unknown", () => {
    expect(codeFromStatus(200)).toBe("unknown");
  });

  it("maps 301 to unknown", () => {
    expect(codeFromStatus(301)).toBe("unknown");
  });
});

describe("failFromStatus()", () => {
  it("returns a failing Result with the right code and status", () => {
    const r = failFromStatus(401, "Unauthorized", { provider: "gmail" });
    if (!r.ok) {
      expect(r.error.code).toBe("auth_expired");
      expect(r.error.status).toBe(401);
      expect(r.error.provider).toBe("gmail");
      expect(r.error.message).toBe("Unauthorized");
    }
  });
});

describe("failFromException()", () => {
  it("handles errors with a numeric status property (ComposioError shape)", () => {
    const e = { status: 429, message: "Too many requests" };
    const r = failFromException(e, "Fallback");
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited");
      expect(r.error.status).toBe(429);
    }
  });

  it("handles Error instances using .message", () => {
    const e = new Error("Network timeout");
    const r = failFromException(e, "Fallback");
    if (!r.ok) {
      expect(r.error.code).toBe("network");
      expect(r.error.message).toBe("Network timeout");
    }
  });

  it("falls back to 'network' code when no status is available", () => {
    const r = failFromException("some string", "Fallback message");
    if (!r.ok) {
      expect(r.error.code).toBe("network");
      expect(r.error.message).toBe("Fallback message");
    }
  });

  it("falls back when Error has empty message", () => {
    const e = new Error("");
    const r = failFromException(e, "Fallback message");
    if (!r.ok) {
      expect(r.error.message).toBe("Fallback message");
    }
  });

  it("maps 5xx status to provider_error", () => {
    const e = { status: 503 };
    const r = failFromException(e, "Fallback");
    if (!r.ok) {
      expect(r.error.code).toBe("provider_error");
    }
  });

  it("includes provider and transport extras", () => {
    const r = failFromException(new Error("fail"), "fb", {
      provider: "outlook",
      transport: "direct",
    });
    if (!r.ok) {
      expect(r.error.provider).toBe("outlook");
      expect(r.error.transport).toBe("direct");
    }
  });
});
