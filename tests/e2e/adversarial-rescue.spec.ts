import { expect, test } from "@playwright/test";

// Adversarial-rescue smoke: public routes + theme matrix entry points.

test("login page exposes terms gate before signup", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const submit = page.getByRole("button", { name: /sign up|create account/i });
  if (await submit.count()) {
    await expect(submit.first()).toBeDisabled();
    const terms = page.getByRole("checkbox");
    if (await terms.count()) {
      await terms.first().check();
      await expect(submit.first()).toBeEnabled();
    }
  }
});

test("command palette route resolves pre-auth without crash", async ({ page }) => {
  await page.goto("/command", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
});
