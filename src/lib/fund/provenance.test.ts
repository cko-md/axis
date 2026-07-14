import { describe, expect, it } from "vitest";
import {
  classifyFreshness,
  FRESHNESS_SLAS,
  isStale,
  reconcileAmount,
  type FreshnessSla,
} from "./provenance";

const SLA: FreshnessSla = { freshWithinMs: 1_000, staleAfterMs: 10_000 };
const NOW = Date.parse("2026-07-13T12:00:00.000Z");

describe("classifyFreshness", () => {
  it("is fresh at or below the fresh threshold", () => {
    expect(classifyFreshness(new Date(NOW).toISOString(), SLA, NOW)).toBe("fresh");
    expect(classifyFreshness(new Date(NOW - 1_000).toISOString(), SLA, NOW)).toBe("fresh");
  });

  it("is delayed between the fresh and stale thresholds", () => {
    expect(classifyFreshness(new Date(NOW - 5_000).toISOString(), SLA, NOW)).toBe("delayed");
    expect(classifyFreshness(new Date(NOW - 10_000).toISOString(), SLA, NOW)).toBe("delayed");
  });

  it("is stale beyond the stale threshold", () => {
    expect(classifyFreshness(new Date(NOW - 10_001).toISOString(), SLA, NOW)).toBe("stale");
  });

  it("returns unknown for missing or invalid timestamps", () => {
    expect(classifyFreshness(null, SLA, NOW)).toBe("unknown");
    expect(classifyFreshness(undefined, SLA, NOW)).toBe("unknown");
    expect(classifyFreshness("not a date", SLA, NOW)).toBe("unknown");
  });

  it("does not report a far-future timestamp as fresh", () => {
    expect(classifyFreshness(new Date(NOW + 5 * 60_000).toISOString(), SLA, NOW)).toBe("unknown");
  });

  it("tolerates small clock skew as fresh", () => {
    expect(classifyFreshness(new Date(NOW + 500).toISOString(), SLA, NOW)).toBe("fresh");
  });

  it("accepts Date instances as well as ISO strings", () => {
    expect(classifyFreshness(new Date(NOW - 500), SLA, NOW)).toBe("fresh");
  });

  it("exposes usable default SLAs per data class", () => {
    expect(FRESHNESS_SLAS.marketPrice.freshWithinMs).toBeLessThan(FRESHNESS_SLAS.accountBalance.freshWithinMs);
  });
});

describe("isStale", () => {
  it("treats stale and unknown as not-authoritative", () => {
    expect(isStale("stale")).toBe(true);
    expect(isStale("unknown")).toBe(true);
    expect(isStale("fresh")).toBe(false);
    expect(isStale("delayed")).toBe(false);
  });
});

describe("reconcileAmount", () => {
  it("matches equal amounts exactly at the cent", () => {
    expect(reconcileAmount(100.1, "100.10")).toBe("matched");
    expect(reconcileAmount(0.1, 0.1)).toBe("matched");
  });

  it("flags disagreement beyond tolerance as conflicting", () => {
    expect(reconcileAmount(100.0, 100.01)).toBe("conflicting");
  });

  it("honors a cent tolerance", () => {
    expect(reconcileAmount(100.0, 100.01, 1)).toBe("matched");
    expect(reconcileAmount(100.0, 100.02, 1)).toBe("conflicting");
  });

  it("reports partial when only one source is present", () => {
    expect(reconcileAmount(100, null)).toBe("partial");
    expect(reconcileAmount(null, 100)).toBe("partial");
    expect(reconcileAmount("", 100)).toBe("partial");
  });

  it("reports missing when neither source is present", () => {
    expect(reconcileAmount(null, undefined)).toBe("missing");
    expect(reconcileAmount("", "")).toBe("missing");
  });
});
