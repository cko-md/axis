import { expect, test } from "@playwright/test";
import { CONSOLE_THEME_QA_CASES } from "../../src/components/console/console-theme-qa";
import { DEFAULT_INTERFACE_SETTINGS } from "../../src/lib/theme/interface-settings";

for (const testCase of CONSOLE_THEME_QA_CASES) {
  test(`console renders under Interface Studio case: ${testCase.name}`, async ({ page }) => {
    await page.setViewportSize(testCase.viewport);
    await page.addInitScript(
      ({ theme, settings }) => {
        window.localStorage.setItem("axis-theme", theme);
        window.localStorage.setItem("axis-interface-settings", JSON.stringify(settings));
      },
      {
        theme: testCase.theme,
        settings: { ...DEFAULT_INTERFACE_SETTINGS, ...testCase.settings },
      },
    );

    await page.goto("/command", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);

    const grid = page.getByTestId("console-grid");
    if (!(await grid.count())) return;

    await expect(grid).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: /resize .* block/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /move .* block/i }).first()).toBeVisible();
  });
}
