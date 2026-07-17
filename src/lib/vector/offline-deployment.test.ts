import { describe, expect, it } from "vitest";
import {
  indexVectorOfflineDeployments,
  parseVectorOfflineBuildMap,
} from "@/lib/vector/offline-deployment";

const BASE = "https://axis.example";

describe("VECTOR offline deployment mapping", () => {
  it("accepts the honest empty Wave 15.2 mapping", () => {
    const parsed = parseVectorOfflineBuildMap({
      schemaVersion: 1,
      buildId: "development-empty",
      games: [],
    }, BASE);
    expect(parsed).toEqual({
      ok: true,
      map: { schemaVersion: 1, buildId: "development-empty", games: [] },
    });
    if (parsed.ok) expect(indexVectorOfflineDeployments(parsed.map)).toEqual({});
  });

  it("refuses deploy artifacts for a registry title that is still planned", () => {
    expect(parseVectorOfflineBuildMap({
      schemaVersion: 1,
      buildId: "fixture-build",
      games: [{
        gameId: "second-sense",
        gameVersion: "1.0.0",
        buildId: "fixture-build",
        manifestUrl: "/vector-assets/manifests/second-sense-fixture-build.json",
        manifestSha256: "a".repeat(64),
        offlineEntryUrl: "/vector-assets/offline/second-sense.html",
        estimatedBytes: 100,
      }],
    }, BASE)).toEqual({
      ok: false,
      error: "VECTOR_OFFLINE_BUILD_MAP_REGISTRY_MISMATCH",
    });
  });

  it("rejects cross-origin manifests and build-id mismatches before actions exist", () => {
    const forged = {
      schemaVersion: 1,
      buildId: "fixture-build",
      games: [{
        gameId: "second-sense",
        gameVersion: "1.0.0",
        buildId: "other-build",
        manifestUrl: "https://evil.example/vector-assets/manifests/game.json",
        manifestSha256: "a".repeat(64),
        offlineEntryUrl: "/vector-assets/offline/second-sense.html",
        estimatedBytes: 100,
      }],
    };
    expect(parseVectorOfflineBuildMap(forged, BASE)).toEqual({
      ok: false,
      error: "VECTOR_OFFLINE_BUILD_MAP_REGISTRY_MISMATCH",
    });
  });
});
