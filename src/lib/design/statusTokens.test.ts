import { describe, expect, it } from "vitest";
import { SEMANTIC_TONE_COLOR, semanticToneColor, type SemanticToneKey } from "./statusTokens";

describe("semantic status tokens", () => {
  it("covers every tone key with a CSS var", () => {
    const keys: SemanticToneKey[] = ["muted", "accent", "success", "warning", "alert", "danger"];
    for (const k of keys) expect(semanticToneColor(k)).toMatch(/^var\(--/);
  });

  it("pins the canonical values (guards against silent palette drift)", () => {
    expect(SEMANTIC_TONE_COLOR.muted).toBe("var(--ink-faint)");
    expect(SEMANTIC_TONE_COLOR.accent).toBe("var(--accent)");
    expect(SEMANTIC_TONE_COLOR.success).toBe("var(--up)");
    expect(SEMANTIC_TONE_COLOR.warning).toBe("var(--clay-2, var(--gold-deep))");
    expect(SEMANTIC_TONE_COLOR.alert).toBe("var(--clay)");
    expect(SEMANTIC_TONE_COLOR.danger).toBe("var(--down)");
  });
});
