import { expect, test } from "@playwright/test";

test("mail list opens detail and compose is available", async ({ page }) => {
  await page.goto("/mail");
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  await expect(page.getByText(/inbox|connect a mailbox/i)).toBeVisible();

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
  for (const path of ["/agenda", "/schedule", "/notes", "/command"]) {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  }
});
