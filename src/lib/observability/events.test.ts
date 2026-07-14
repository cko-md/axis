import { describe, expect, it } from "vitest";
import { redactSafe, structuredEvent } from "./events";

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

  it("guards against deep/cyclic-ish nesting with a depth limit", () => {
    let obj: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) obj = { nested: obj };
    expect(() => redactSafe(obj)).not.toThrow();
  });

  it("structuredEvent stamps event + ts and redacts fields", () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const e = structuredEvent("routine.run.completed", { token: "x", runId: "r1" }, now);
    expect(e.event).toBe("routine.run.completed");
    expect(e.ts).toBe("2026-07-14T00:00:00.000Z");
    expect(e.token).toBe("[redacted]");
    expect(e.runId).toBe("r1");
  });
});
