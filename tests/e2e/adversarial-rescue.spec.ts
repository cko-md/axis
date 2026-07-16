import { expect, test } from "@playwright/test";

// Adversarial-rescue smoke: public routes + theme matrix entry points.

test("login page exposes terms gate before signup", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();

  const submit = page.getByRole("button", { name: "Create account", exact: true });
  const terms = page.locator("#tos-consent");

  await expect(submit).toBeDisabled();
  await terms.check();
  await expect(submit).toBeEnabled();
});

test("command palette route resolves pre-auth without crash", async ({ page }) => {
  await page.goto("/command", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
});
