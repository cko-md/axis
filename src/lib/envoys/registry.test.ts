import { describe, expect, it } from "vitest";
import { HATCH_ENVOY_IDS } from "@/lib/envoys/hatchPackage";
import {
  DEFAULT_ENVOY_ID,
  ENVOY_IDS,
  ENVOY_REGISTRY,
  envoyIdFromLegacyCompanion,
  getEnvoy,
  isEnvoyId,
} from "@/lib/envoys/registry";

describe("envoy registry", () => {
  it("derives status from validated hatch packages — all four starters are hatched in Wave 15.5", () => {
    expect(ENVOY_REGISTRY.map((record) => record.id)).toEqual([...ENVOY_IDS]);
    for (const record of ENVOY_REGISTRY) {
      // Status is derived (envoyStatusFor), never asserted: these read
      // "hatched" only because every package in hatchPackage.ts validates.
      expect(record.status).toBe("hatched");
      expect(record.name.length).toBeGreaterThan(0);
      expect(record.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps the hatch-package leaf id list in exact sync with ENVOY_IDS", () => {
    expect([...HATCH_ENVOY_IDS]).toEqual([...ENVOY_IDS]);
  });

  it("resolves and validates envoy ids", () => {
    expect(isEnvoyId("meridian")).toBe(true);
    expect(isEnvoyId("monolith")).toBe(false);
    expect(isEnvoyId(null)).toBe(false);
    expect(getEnvoy("vesper").name).toBe("Vesper");
  });

  it("maps every legacy companion vocabulary to a stable starter id (VE-RISK-009)", () => {
    expect(envoyIdFromLegacyCompanion("monolith")).toBe("meridian");
    expect(envoyIdFromLegacyCompanion("axiom")).toBe("meridian");
    expect(envoyIdFromLegacyCompanion("deck")).toBe("cairn");
    expect(envoyIdFromLegacyCompanion("codex")).toBe("cairn");
    expect(envoyIdFromLegacyCompanion("nova")).toBe("vesper");
    expect(envoyIdFromLegacyCompanion(" NOVA ")).toBe("vesper");
  });

  it("passes through already-valid envoy ids and falls back safely on corrupt input", () => {
    expect(envoyIdFromLegacyCompanion("solace")).toBe("solace");
    expect(envoyIdFromLegacyCompanion("")).toBe(DEFAULT_ENVOY_ID);
    expect(envoyIdFromLegacyCompanion("__proto__")).toBe(DEFAULT_ENVOY_ID);
    expect(envoyIdFromLegacyCompanion(42)).toBe(DEFAULT_ENVOY_ID);
    expect(envoyIdFromLegacyCompanion(undefined)).toBe(DEFAULT_ENVOY_ID);
    expect(envoyIdFromLegacyCompanion({ companion: "nova" })).toBe(DEFAULT_ENVOY_ID);
  });
});
