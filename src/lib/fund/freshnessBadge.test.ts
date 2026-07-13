import { describe, expect, it } from "vitest";
import { freshnessBadgeView, relativeTimeShort } from "./freshnessBadge";
import { classifyFreshness, FRESHNESS_SLAS } from "./provenance";

describe("freshnessBadgeView — tone + label mapping", () => {
  it("maps each tier to a distinct tone", () => {
    expect(freshnessBadgeView("fresh").tone).toBe("positive");
    expect(freshnessBadgeView("delayed").tone).toBe("caution");
    expect(freshnessBadgeView("stale").tone).toBe("negative");
    expect(freshnessBadgeView("unknown").tone).toBe("muted");
  });

  it("carries the tier through and always has non-empty copy", () => {
    for (const tier of ["fresh", "delayed", "stale", "unknown"] as const) {
      const view = freshnessBadgeView(tier);
      expect(view.tier).toBe(tier);
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.description.length).toBeGreaterThan(0);
    }
  });

  it("composes with classifyFreshness end to end", () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    const oneHourAgo = "2026-07-13T11:00:00.000Z";
    const tier = classifyFreshness(oneHourAgo, FRESHNESS_SLAS.accountBalance, now);
    expect(tier).toBe("fresh");
    expect(freshnessBadgeView(tier).label).toBe("Live");
  });
});

describe("relativeTimeShort", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("says 'just now' under 45s", () => {
    expect(relativeTimeShort(ago(10_000), now)).toBe("just now");
  });

  it("formats minutes, hours, days, weeks, months", () => {
    expect(relativeTimeShort(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeTimeShort(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(relativeTimeShort(ago(2 * 86_400_000), now)).toBe("2d ago");
    expect(relativeTimeShort(ago(14 * 86_400_000), now)).toBe("2w ago");
    expect(relativeTimeShort(ago(60 * 86_400_000), now)).toBe("2mo ago");
  });

  it("returns null for missing, invalid, or future timestamps", () => {
    expect(relativeTimeShort(null, now)).toBeNull();
    expect(relativeTimeShort(undefined, now)).toBeNull();
    expect(relativeTimeShort("not-a-date", now)).toBeNull();
    expect(relativeTimeShort(ago(-5 * 60_000), now)).toBeNull();
  });

  it("tolerates small clock skew (near-now future) as 'just now'", () => {
    expect(relativeTimeShort(new Date(now + 5_000).toISOString(), now)).toBe("just now");
  });
});
