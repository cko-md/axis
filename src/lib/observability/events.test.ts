import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalEventPolicy,
  createObservabilityRequestId,
  emitServerEvent,
  eventDurationMs,
  redactSafe,
  routineEventErrorCode,
  routineEventStage,
  structuredEvent,
} from "./events";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-14T00:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("observability redaction", () => {
  it("masks sensitive keys at any depth", () => {
    const input = {
      routine: "concentration_review",
      access_token: "abc123",
      user: { email: "a@b.com", id: "u1", password: "hunter2" },
      items: [{ apiKey: "k", value: 3 }],
    };
    const out = redactSafe(input) as Record<string, unknown>;
    expect(out.routine).toBe("concentration_review");
    expect(out.access_token).toBe("[redacted]");
    const user = out.user as Record<string, unknown>;
    expect(user.email).toBe("[redacted]");
    expect(user.password).toBe("[redacted]");
    expect(user.id).toBe("u1");
    const items = out.items as Record<string, unknown>[];
    expect(items[0].apiKey).toBe("[redacted]");
    expect(items[0].value).toBe(3);
  });

  it("leaves non-sensitive scalars untouched", () => {
    expect(redactSafe({ count: 5, status: "completed" })).toEqual({ count: 5, status: "completed" });
  });

  it("guards against deep nesting with a depth limit", () => {
    let obj: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) obj = { nested: obj };
    expect(() => redactSafe(obj)).not.toThrow();
  });
});

describe("closed structured-event contract", () => {
  it("builds an allowlisted event with fixed envelope metadata", () => {
    const event = structuredEvent("approval.decided", {
      requestId: REQUEST_ID,
      approvalId: APPROVAL_ID,
      decision: "approved",
      actionClass: "INTERNAL_WRITE",
      requirement: "approval",
      decisionLatencyMs: 1_000,
    }, NOW);

    expect(event).toMatchObject({
      event: "approval.decided",
      schemaVersion: 1,
      ts: NOW.toISOString(),
      requestId: REQUEST_ID,
      approvalId: APPROVAL_ID,
      decision: "approved",
    });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects unknown fields before any caller content can be logged", () => {
    expect(() => structuredEvent(
      "routine.run.completed",
      {
        requestId: REQUEST_ID,
        routine: "concentration_review",
        runId: RUN_ID,
        status: "completed",
        breaches: 0,
        tasksCreated: 0,
        tasksSkipped: 0,
        resumedFromApproval: false,
        holdings: [{ symbol: "PRIVATE", value: 500 }],
      } as never,
      NOW,
    )).toThrow("invalid_payload");
  });

  it("rejects invalid identifiers, arbitrary errors, and financial values", () => {
    expect(() => structuredEvent(
      "routine.run.blocked",
      {
        requestId: "person@example.com",
        routine: "concentration_review",
        runId: RUN_ID,
        errorCode: "Account 123 has balance 500",
        stage: "execute",
        resumedFromApproval: false,
      } as never,
      NOW,
    )).toThrow("invalid_payload");
  });

  it("enforces consistency between requirement and step-up flag", () => {
    expect(() => structuredEvent("approval.executed", {
      requestId: REQUEST_ID,
      approvalId: APPROVAL_ID,
      actionClass: "FINANCIAL_EXECUTION",
      requirement: "approval_step_up",
      stepUpRequired: false,
      executeLatencyMs: 1_000,
    }, NOW)).toThrow("invalid_payload");
  });

  it("fails closed without echoing a rejected payload", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const privateText = "person@example.com has $9876";

    const emitted = emitServerEvent(
      "routine.run.blocked",
      {
        requestId: REQUEST_ID,
        routine: "concentration_review",
        runId: RUN_ID,
        errorCode: privateText,
        stage: "execute",
        resumedFromApproval: false,
      } as never,
    );

    expect(emitted).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("observability.event.rejected");
    expect(warn.mock.calls[0][0]).not.toContain(privateText);
  });
});

describe("safe event metadata helpers", () => {
  it("generates opaque UUID request ids", () => {
    expect(createObservabilityRequestId()).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("returns only bounded non-negative durations", () => {
    expect(eventDurationMs("2026-07-13T23:59:59.000Z", NOW.getTime())).toBe(1_000);
    expect(eventDurationMs("2026-07-14T00:00:01.000Z", NOW.getTime())).toBeNull();
    expect(eventDurationMs("not-a-date", NOW.getTime())).toBeNull();
  });

  it("normalizes arbitrary routine errors and stages to fixed values", () => {
    expect(routineEventErrorCode(new Error("HOLDINGS_UNAVAILABLE"))).toBe("HOLDINGS_UNAVAILABLE");
    expect(routineEventErrorCode(new Error("person@example.com has $500"))).toBe("UNEXPECTED_ROUTINE_FAILURE");
    expect(routineEventStage("load_prices")).toBe("load_prices");
    expect(routineEventStage("account person@example.com")).toBe("run");
  });

  it("accepts only valid persisted approval policy pairs", () => {
    expect(approvalEventPolicy("INTERNAL_WRITE", "approval")).toEqual({
      actionClass: "INTERNAL_WRITE",
      requirement: "approval",
    });
    expect(approvalEventPolicy("FINANCIAL_EXECUTION", "approval")).toBeNull();
    expect(approvalEventPolicy("READ", "auto")).toBeNull();
  });
});
