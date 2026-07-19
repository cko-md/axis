import type { EnvoyId } from "@/lib/envoys/registry";

/**
 * Runtime copy of the starter id list. This module must stay a LEAF (no
 * runtime import of registry.ts — registry imports envoyStatusFor from here
 * to derive each starter's status, and a runtime cycle would TDZ at module
 * load). registry.test.ts asserts this list matches ENVOY_IDS exactly so
 * the two cannot drift.
 */
export const HATCH_ENVOY_IDS = ["meridian", "cairn", "vesper", "solace"] as const;

/**
 * Starter hatch-pet packages (Wave 15.5).
 *
 * A hatch package is the validated artifact bundle that lets a starter Envoy
 * graduate from "candidate" to "hatched": an original, hand-authored artwork
 * asset plus its display metadata. Validation is deterministic and pure —
 * the registry derives an Envoy's status from it at module load, so a
 * package that fails validation can never present its starter as hatched
 * (see envoyStatusFor below). No AI-generated imagery is used or claimed;
 * every asset under /envoy-assets/ is hand-authored SVG in this repo.
 *
 * This wave covers static identity art only. Animated sprite states and the
 * generation pipeline (15.6/15.7) remain out of scope and gated.
 */

export type HatchPackage = {
  envoyId: EnvoyId;
  version: string;
  artworkUrl: `/envoy-assets/${string}.svg`;
  /** Intrinsic square dimension of the artwork viewBox, in CSS px. */
  artworkSize: number;
  alt: string;
  /** Dominant palette, for future HUD accents; 2–4 entries. */
  palette: readonly string[];
  authorship: "hand-authored-svg";
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ARTWORK_URL = /^\/envoy-assets\/[a-z0-9-]+\.svg$/;

export type HatchPackageIssue = {
  envoyId: string;
  code:
    | "UNKNOWN_ENVOY"
    | "INVALID_VERSION"
    | "INVALID_ARTWORK_URL"
    | "ARTWORK_URL_MISMATCH"
    | "INVALID_ARTWORK_SIZE"
    | "MISSING_ALT"
    | "INVALID_PALETTE"
    | "INVALID_AUTHORSHIP";
};

/** Pure, deterministic package validation. Returns every issue, not just the first. */
export function getHatchPackageIssues(candidate: HatchPackage): HatchPackageIssue[] {
  const issues: HatchPackageIssue[] = [];
  const envoyId = String(candidate.envoyId);
  if (!(HATCH_ENVOY_IDS as readonly string[]).includes(envoyId)) {
    issues.push({ envoyId, code: "UNKNOWN_ENVOY" });
  }
  if (!SEMVER.test(candidate.version)) {
    issues.push({ envoyId, code: "INVALID_VERSION" });
  }
  if (!ARTWORK_URL.test(candidate.artworkUrl)) {
    issues.push({ envoyId, code: "INVALID_ARTWORK_URL" });
  } else if (candidate.artworkUrl !== `/envoy-assets/${envoyId}.svg`) {
    // The asset must be the one named for this starter — a package cannot
    // claim another starter's artwork.
    issues.push({ envoyId, code: "ARTWORK_URL_MISMATCH" });
  }
  if (!Number.isInteger(candidate.artworkSize) || candidate.artworkSize < 120 || candidate.artworkSize > 1024) {
    issues.push({ envoyId, code: "INVALID_ARTWORK_SIZE" });
  }
  if (typeof candidate.alt !== "string" || candidate.alt.trim().length < 12) {
    issues.push({ envoyId, code: "MISSING_ALT" });
  }
  if (
    !Array.isArray(candidate.palette)
    || candidate.palette.length < 2
    || candidate.palette.length > 4
    || candidate.palette.some((color) => !HEX_COLOR.test(color))
  ) {
    issues.push({ envoyId, code: "INVALID_PALETTE" });
  }
  if (candidate.authorship !== "hand-authored-svg") {
    issues.push({ envoyId, code: "INVALID_AUTHORSHIP" });
  }
  return issues;
}

export const HATCH_PACKAGES: readonly HatchPackage[] = [
  {
    envoyId: "meridian",
    version: "1.0.0",
    artworkUrl: "/envoy-assets/meridian.svg",
    artworkSize: 240,
    alt: "Meridian, a hooded wayfarer holding a small glowing lantern.",
    palette: ["#232a3d", "#e8dfc9", "#e0c388"],
    authorship: "hand-authored-svg",
  },
  {
    envoyId: "cairn",
    version: "1.0.0",
    artworkUrl: "/envoy-assets/cairn.svg",
    artworkSize: 240,
    alt: "Cairn, a friendly creature of stacked river stones with small arms.",
    palette: ["#343b50", "#e8dfc9", "#e0c388"],
    authorship: "hand-authored-svg",
  },
  {
    envoyId: "vesper",
    version: "1.0.0",
    artworkUrl: "/envoy-assets/vesper.svg",
    artworkSize: 240,
    alt: "Vesper, a gentle moth-winged signal keeper with a soft glow.",
    palette: ["#2b3350", "#e8dfc9", "#7fb0ff"],
    authorship: "hand-authored-svg",
  },
  {
    envoyId: "solace",
    version: "1.0.0",
    artworkUrl: "/envoy-assets/solace.svg",
    artworkSize: 240,
    alt: "Solace, a round harbor keeper in an oilskin coat holding a warm light.",
    palette: ["#3d3427", "#e8dfc9", "#e0c388"],
    authorship: "hand-authored-svg",
  },
];

const VALID_PACKAGES = new Map<EnvoyId, HatchPackage>(
  HATCH_PACKAGES
    .filter((candidate) => getHatchPackageIssues(candidate).length === 0)
    .map((candidate) => [candidate.envoyId, candidate]),
);

/** The validated package for a starter, or null if none validates. */
export function getHatchPackage(envoyId: EnvoyId): HatchPackage | null {
  return VALID_PACKAGES.get(envoyId) ?? null;
}

/**
 * Derived, honest status: "hatched" only when a package fully validates.
 * The registry consumes this — status can never be asserted independently
 * of the validated artifact.
 */
export function envoyStatusFor(envoyId: EnvoyId): "candidate" | "hatched" {
  return VALID_PACKAGES.has(envoyId) ? "hatched" : "candidate";
}
