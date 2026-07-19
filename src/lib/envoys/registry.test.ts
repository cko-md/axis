import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENVOY_ID,
  ENVOY_IDS,
  ENVOY_REGISTRY,
  envoyIdFromLegacyCompanion,
  getEnvoy,
  isEnvoyId,
} from "@/lib/envoys/registry";

describe("envoy registry", () => {
  it("keeps every starter an honest candidate until Wave 15.5 hatch packages exist", () => {
    expect(ENVOY_REGISTRY.map((record) => record.id)).toEqual([...ENVOY_IDS]);
    for (const record of ENVOY_REGISTRY) {
      expect(record.status).toBe("candidate");
      expect(record.name.length).toBeGreaterThan(0);
      expect(record.description.length).toBeGreaterThan(0);
    }
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
