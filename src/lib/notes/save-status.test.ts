import { describe, expect, it } from "vitest";
import { autosaveStatusTone, formatAutosaveLabel } from "@/lib/notes/save-status";

const NOW = new Date("2026-07-03T12:00:00.000Z").getTime();

describe("formatAutosaveLabel", () => {
  it("shows a live saving state", () => {
    expect(formatAutosaveLabel("saving", null, NOW)).toBe("Saving…");
  });

  it("shows a distinct failure state", () => {
    expect(formatAutosaveLabel("error", "2026-07-03T11:59:00.000Z", NOW)).toBe("Save failed");
  });

  it("falls back to plain Saved with no confirmed timestamp", () => {
    expect(formatAutosaveLabel("saved", null, NOW)).toBe("Saved");
    expect(formatAutosaveLabel("idle", null, NOW)).toBe("Saved");
  });

  it("reports a confirmed recent save as 'just now'", () => {
    expect(formatAutosaveLabel("saved", "2026-07-03T11:59:58.000Z", NOW)).toBe("Saved just now");
  });

  it("reports seconds-ago then clock time as the save ages", () => {
    expect(formatAutosaveLabel("saved", "2026-07-03T11:59:30.000Z", NOW)).toBe("Saved 30s ago");
    expect(formatAutosaveLabel("idle", "2026-07-03T11:00:00.000Z", NOW)).toMatch(/^Saved /);
    expect(formatAutosaveLabel("idle", "2026-07-03T11:00:00.000Z", NOW)).not.toBe("Saved just now");
  });

  it("degrades gracefully on an unparseable timestamp", () => {
    expect(formatAutosaveLabel("saved", "not-a-date", NOW)).toBe("Saved");
  });
});

describe("autosaveStatusTone", () => {
  it("maps status to a semantic tone", () => {
    expect(autosaveStatusTone("saving")).toBe("pending");
    expect(autosaveStatusTone("error")).toBe("error");
    expect(autosaveStatusTone("saved")).toBe("ok");
    expect(autosaveStatusTone("idle")).toBe("ok");
  });
});
