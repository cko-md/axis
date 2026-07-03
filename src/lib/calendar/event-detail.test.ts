import { describe, expect, it } from "vitest";
import { resolveCleanupTransport, validateEventPatch } from "@/lib/calendar/event-detail";

describe("validateEventPatch", () => {
  const valid = {
    title: "Standup",
    description: "Daily sync",
    start_at: "2026-07-02T09:00:00.000Z",
    end_at: "2026-07-02T09:30:00.000Z",
    color_class: "b",
  };

  it("accepts a fully valid patch and normalizes dates/description", () => {
    const result = validateEventPatch(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({
        title: "Standup",
        description: "Daily sync",
        start_at: "2026-07-02T09:00:00.000Z",
        end_at: "2026-07-02T09:30:00.000Z",
        color_class: "b",
      });
    }
  });

  it("trims title/description and nulls empty description", () => {
    const result = validateEventPatch({ ...valid, title: "  Standup  ", description: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.title).toBe("Standup");
      expect(result.patch.description).toBeNull();
    }
  });

  it("rejects a missing/blank title", () => {
    const result = validateEventPatch({ ...valid, title: "   " });
    expect(result).toEqual({ ok: false, error: "Title is required", status: 422 });
  });

  it("rejects missing or unparseable start/end", () => {
    expect(validateEventPatch({ ...valid, start_at: undefined })).toEqual({
      ok: false, error: "Start and end times are required", status: 422,
    });
    expect(validateEventPatch({ ...valid, end_at: "not-a-date" })).toEqual({
      ok: false, error: "Start and end times are required", status: 422,
    });
  });

  it("rejects end <= start", () => {
    const result = validateEventPatch({ ...valid, end_at: valid.start_at });
    expect(result).toEqual({ ok: false, error: "End time must be after start time", status: 422 });
  });

  it("rejects a color outside the DB CHECK-constrained set", () => {
    const result = validateEventPatch({ ...valid, color_class: "orange" });
    expect(result).toEqual({ ok: false, error: "Invalid event color", status: 422 });
  });
});

describe("resolveCleanupTransport", () => {
  const composioAccounts = [
    { provider: "googlecalendar" as const, connectedAccountId: "ca-google" },
    { provider: "outlook" as const, connectedAccountId: "ca-outlook" },
  ];

  it("prefers legacy direct-OAuth over a Composio connection for the same provider", () => {
    expect(resolveCleanupTransport("google", new Set(["google"]), composioAccounts)).toEqual({ transport: "direct" });
  });

  it("falls back to Composio when no legacy connection exists", () => {
    expect(resolveCleanupTransport("google", new Set(), composioAccounts)).toEqual({
      transport: "composio",
      connectedAccountId: "ca-google",
    });
    expect(resolveCleanupTransport("outlook", new Set(), composioAccounts)).toEqual({
      transport: "composio",
      connectedAccountId: "ca-outlook",
    });
  });

  it("returns none when neither transport is connected, so cleanup can be flagged as skipped", () => {
    expect(resolveCleanupTransport("google", new Set(), [])).toEqual({ transport: "none" });
  });

  it("does not cross-match outlook composio accounts onto google (and vice versa)", () => {
    expect(resolveCleanupTransport("google", new Set(), [composioAccounts[1]])).toEqual({ transport: "none" });
    expect(resolveCleanupTransport("outlook", new Set(), [composioAccounts[0]])).toEqual({ transport: "none" });
  });
});
