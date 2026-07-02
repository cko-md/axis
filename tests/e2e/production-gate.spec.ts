import { expect, test } from "@playwright/test";

test("auth shell loads the login surface", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /welcome|sign in|axis/i })).toBeVisible();
});

test("protected modules do not crash before authentication", async ({ page }) => {
  for (const path of ["/mail", "/schedule", "/notes", "/command"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  }
});
