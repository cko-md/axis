import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  envoyStatusFor,
  getHatchPackage,
  getHatchPackageIssues,
  HATCH_PACKAGES,
  type HatchPackage,
} from "@/lib/envoys/hatchPackage";
import { ENVOY_IDS } from "@/lib/envoys/registry";

const VALID: HatchPackage = {
  envoyId: "meridian",
  version: "1.0.0",
  artworkUrl: "/envoy-assets/meridian.svg",
  artworkSize: 240,
  alt: "Meridian, a hooded wayfarer holding a small glowing lantern.",
  palette: ["#232a3d", "#e8dfc9", "#e0c388"],
  authorship: "hand-authored-svg",
};

describe("hatch packages", () => {
  it("every shipped starter package validates deterministically", () => {
    expect(HATCH_PACKAGES.map((candidate) => candidate.envoyId)).toEqual([...ENVOY_IDS]);
    for (const candidate of HATCH_PACKAGES) {
      expect(getHatchPackageIssues(candidate)).toEqual([]);
      expect(envoyStatusFor(candidate.envoyId)).toBe("hatched");
      expect(getHatchPackage(candidate.envoyId)?.artworkUrl).toBe(candidate.artworkUrl);
    }
  });

  it("every declared artwork asset exists on disk as well-formed hand-authored SVG with an accessible title", () => {
    for (const candidate of HATCH_PACKAGES) {
      const source = readFileSync(`public${candidate.artworkUrl}`, "utf8");
      expect(source).toMatch(/^<svg /);
      expect(source).toMatch(/viewBox="0 0 240 240"/);
      expect(source).toMatch(/role="img"/);
      expect(source).toMatch(/<title /);
      // No raster/base64 payloads and no external fetches — hand-authored
      // vector art only, self-contained.
      expect(source).not.toMatch(/data:image|<image|href="http/);
    }
  });

  it("rejects a package claiming another starter's artwork", () => {
    const issues = getHatchPackageIssues({ ...VALID, artworkUrl: "/envoy-assets/cairn.svg" });
    expect(issues.map((issue) => issue.code)).toEqual(["ARTWORK_URL_MISMATCH"]);
  });

  it("rejects unknown ids, bad versions, bad sizes, short alt text, and bad palettes", () => {
    expect(getHatchPackageIssues({ ...VALID, envoyId: "impostor" as never }).map((issue) => issue.code))
      .toContain("UNKNOWN_ENVOY");
    expect(getHatchPackageIssues({ ...VALID, version: "1.0" }).map((issue) => issue.code))
      .toContain("INVALID_VERSION");
    expect(getHatchPackageIssues({ ...VALID, artworkSize: 64 }).map((issue) => issue.code))
      .toContain("INVALID_ARTWORK_SIZE");
    expect(getHatchPackageIssues({ ...VALID, alt: "Too short" }).map((issue) => issue.code))
      .toContain("MISSING_ALT");
    expect(getHatchPackageIssues({ ...VALID, palette: ["#fff"] }).map((issue) => issue.code))
      .toContain("INVALID_PALETTE");
    expect(getHatchPackageIssues({ ...VALID, authorship: "ai-generated" as never }).map((issue) => issue.code))
      .toContain("INVALID_AUTHORSHIP");
  });

  it("rejects artwork URLs outside /envoy-assets/", () => {
    const issues = getHatchPackageIssues({
      ...VALID,
      artworkUrl: "https://evil.example/meridian.svg" as never,
    });
    expect(issues.map((issue) => issue.code)).toContain("INVALID_ARTWORK_URL");
  });
});
