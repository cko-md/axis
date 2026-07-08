import { describe, expect, it } from "vitest";
import { ALLOWED_AI_MODES, isAllowedAiMode } from "@/lib/ai/modes";
import { AI_ACTION_DEFS } from "@/lib/ai/actions";

describe("AI mode allowlist", () => {
  it("includes every registered action mode", () => {
    for (const def of Object.values(AI_ACTION_DEFS)) {
      expect(ALLOWED_AI_MODES.has(def.mode), `${def.mode} missing from allowlist`).toBe(true);
    }
  });

  it("rejects unknown modes", () => {
    expect(isAllowedAiMode("capture")).toBe(true);
    expect(isAllowedAiMode("totally-fake-mode")).toBe(false);
  });

  it("allows route-only modes used by API handlers", () => {
    expect(isAllowedAiMode("triage-person")).toBe(true);
    expect(isAllowedAiMode("literature-relevance")).toBe(true);
    expect(isAllowedAiMode("pipeline-draft")).toBe(true);
  });
});
