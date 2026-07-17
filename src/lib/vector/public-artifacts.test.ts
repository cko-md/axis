import { describe, expect, it } from "vitest";
import { isPublicVectorArtifactPath } from "@/lib/vector/public-artifacts";

describe("VECTOR public artifact paths", () => {
  it("allows only the exact worker and offline document plus the asset directory", () => {
    expect(isPublicVectorArtifactPath("/sw.js")).toBe(true);
    expect(isPublicVectorArtifactPath("/vector-offline.html")).toBe(true);
    expect(isPublicVectorArtifactPath("/vector-assets/manifests/second-sense.json")).toBe(true);

    expect(isPublicVectorArtifactPath("/sw.js-private")).toBe(false);
    expect(isPublicVectorArtifactPath("/vector-offline.html.bak")).toBe(false);
    expect(isPublicVectorArtifactPath("/vector-assets")).toBe(false);
    expect(isPublicVectorArtifactPath("/vector-assets-private/file.js")).toBe(false);
  });
});
