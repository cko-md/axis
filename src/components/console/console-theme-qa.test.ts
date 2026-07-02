import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS } from "@/lib/theme/interface-settings";
import { CONSOLE_THEME_QA_CASES } from "@/components/console/console-theme-qa";

describe("Console theme QA matrix", () => {
  it("covers all shipped theme modes", () => {
    expect(new Set(CONSOLE_THEME_QA_CASES.map((testCase) => testCase.theme))).toEqual(
      new Set(["dark", "dim", "slate", "light"]),
    );
  });

  it("keeps QA cases tied to valid Interface Studio settings", () => {
    for (const testCase of CONSOLE_THEME_QA_CASES) {
      expect(testCase.viewport.width).toBeGreaterThanOrEqual(390);
      expect(testCase.viewport.height).toBeGreaterThanOrEqual(800);
      if (testCase.settings.accent) {
        expect(Object.keys(ACCENT_PRESETS)).toContain(testCase.settings.accent);
      }
      if (testCase.settings.cornerRadius !== undefined) {
        expect(testCase.settings.cornerRadius).toBeGreaterThanOrEqual(0);
        expect(testCase.settings.cornerRadius).toBeLessThanOrEqual(16);
      }
    }
  });
});

