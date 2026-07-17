import { describe, expect, it } from "vitest";
import {
  aiDegradationLabel,
  MODEL_AI_RESPONSE_METADATA,
  degradedAiResponseMetadata,
  parseAiResponseMetadata,
  withAiResponseMetadata,
} from "@/lib/ai/response";

describe("AI response metadata", () => {
  it("marks model output as non-degraded", () => {
    expect(withAiResponseMetadata(
      { label: "Action" },
      MODEL_AI_RESPONSE_METADATA,
    )).toEqual({
      label: "Action",
      meta: {
        source: "model",
        degraded: false,
        reason: null,
      },
    });
  });

  it("marks local output with a typed degradation reason", () => {
    expect(degradedAiResponseMetadata("provider_error")).toEqual({
      source: "heuristic",
      degraded: true,
      reason: "provider_error",
    });
  });

  it("rejects inconsistent metadata", () => {
    expect(parseAiResponseMetadata({
      source: "model",
      degraded: true,
      reason: null,
    })).toBeNull();
  });

  it("provides explicit user-facing degradation labels", () => {
    expect(aiDegradationLabel("not_configured")).toContain("not configured");
    expect(aiDegradationLabel("provider_error")).toContain("unavailable");
    expect(aiDegradationLabel("provider_rate_limited")).toContain("rate limited");
  });
});
