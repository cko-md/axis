import { expect, test } from "@playwright/test";

test("mail list opens detail and compose is available", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/mail");
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: 30_000 });

  const firstMessage = page.locator('[data-testid="mail-row"]').first();
  if (await firstMessage.count()) {
    await firstMessage.click();
    await expect(page.getByText(/from:/i)).toBeVisible();
    await expect(page.getByText(/show images|hide images/i)).toBeVisible();
  }

  const compose = page.getByRole("button", { name: /compose/i });
  if (await compose.count()) await expect(compose).toBeEnabled();
});

test("task, schedule, note, and console routes load cleanly", async ({ page }) => {
  test.setTimeout(120_000);
  for (const path of ["/agenda", "/schedule", "/notes", "/command"]) {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  }
});

// DISP-3: legacy duplicate routes 308-redirect to their canonical counterparts.
// Only reachable when authenticated — middleware sends unauthenticated users to
// /login before the page-level redirect runs.
test("legacy routes redirect to canonical destinations", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/console");
  await expect(page).toHaveURL(/\/command$/);

  await page.goto("/signals");
  await expect(page).toHaveURL(/\/dispatch$/);
});

test("financial profile and memory lifecycle persist", async ({ page }) => {
  test.setTimeout(120_000);
  const memory = `E2E planning context ${Date.now()}`;
  const updatedMemory = `${memory} updated`;

  await page.goto("/memory");
  await expect(page.getByRole("heading", { name: "Your explicit planning constraints" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Not now" }).click({ timeout: 5_000 }).catch(() => {});

  await page.getByLabel("Base currency").fill("USD");
  await page.getByLabel("Liquidity buffer (months)").fill("7");
  await page.getByLabel("Position concentration limit (%)").fill("17.5");
  await page.getByLabel("Priorities, one per line").fill("Resilience\nOptionality");
  await page.getByLabel("Constraints, one per line").fill("No leverage");
  await page.getByRole("button", { name: "Confirm profile" }).click();
  await expect(page.getByText("Financial operating profile confirmed.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Liquidity buffer (months)")).toHaveValue("7");
  await expect(page.getByLabel("Position concentration limit (%)")).toHaveValue("17.5");
  await expect(page.getByLabel("Priorities, one per line")).toHaveValue("Resilience\nOptionality");

  await page.getByRole("button", { name: "Add memory" }).click();
  const editor = page.getByRole("dialog", { name: "Add memory" });
  await editor.getByLabel("Kind").selectOption("constraint");
  await editor.getByLabel("Scope").selectOption("financial");
  await editor.getByRole("textbox", { name: "Context", exact: true }).fill(memory);
  await editor.getByLabel("Confidence (%)").fill("90");
  await editor.getByRole("button", { name: "Add memory" }).click();
  await expect(page.getByText(memory, { exact: true })).toBeVisible();

  const card = page.locator(".card").filter({ hasText: memory });
  await card.getByRole("button", { name: "Edit memory" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit memory" });
  await editDialog.getByRole("textbox", { name: "Context", exact: true }).fill(updatedMemory);
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(updatedMemory, { exact: true })).toBeVisible();

  const updatedCard = page.locator(".card").filter({ hasText: updatedMemory });
  await updatedCard.getByRole("button", { name: "Archive memory" }).click();
  await page.getByRole("dialog", { name: "Archive memory" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText(updatedMemory, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Archived" }).click();
  const archivedCard = page.locator(".card").filter({ hasText: updatedMemory });
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Active" }).click();
  await expect(page.getByText(updatedMemory, { exact: true })).toBeVisible();
});

test("design-system gallery preserves theme, motion, dialog, and responsive contracts", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/design-system");

  await expect(page.getByRole("heading", { name: "AXIS Design System" })).toBeVisible();
  const themeGroup = page.getByRole("group", { name: "Color theme" });
  for (const theme of ["Dark", "Dim", "Slate", "Light"] as const) {
    const option = themeGroup.getByRole("button", { name: theme, exact: true });
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate((value) => {
      const themes = ["dim", "slate", "light"];
      return value === "dark"
        ? themes.every((item) => !document.documentElement.classList.contains(item))
        : document.documentElement.classList.contains(value);
    }, theme.toLowerCase())).toBe(true);
  }

  const reducedDuration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-base").trim(),
  );
  expect(reducedDuration).toBe("0.01ms");

  await page.evaluate(() => document.body.style.setProperty("--disp", "monospace"));
  await expect.poll(() => page.locator("p").filter({ hasText: "DECISIONS, IN FOCUS" }).evaluate(
    (element) => getComputedStyle(element).fontFamily.toLowerCase(),
  )).toContain("monospace");

  const dialogTrigger = page.getByRole("button", { name: "Open dialog" });
  await dialogTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Review dialog" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(dialogTrigger).toBeFocused();

  const loadingButton = page.getByRole("button", { name: "Run check" });
  await loadingButton.click();
  await expect(loadingButton).toHaveAttribute("aria-busy", "true");
  await expect(loadingButton).toContainText("Run check");
  await expect(loadingButton).not.toHaveAttribute("aria-busy", "true", { timeout: 5_000 });
  await expect(page.getByRole("status").filter({ hasText: "loading-state contract completed" })).toBeVisible();

  await page.getByRole("button", { name: "Destructive" }).click();
  const destructiveDialog = page.getByRole("dialog", { name: "Confirm destructive action" });
  await expect(destructiveDialog).toBeVisible();
  await destructiveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(destructiveDialog).toHaveCount(0);

  for (const width of [1024, 800, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 820 });
    await expect.poll(() => page.locator("main").evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }
});
