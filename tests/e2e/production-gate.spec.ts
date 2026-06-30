import { expect, test } from "@playwright/test";

const authState = process.env.E2E_AUTH_STATE;

test("auth shell loads the login surface", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /welcome|sign in|axis/i })).toBeVisible();
});

test("protected modules do not crash before authentication", async ({ page }) => {
  for (const path of ["/mail", "/schedule", "/notes", "/command"]) {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  }
});

test.describe("authenticated production workflows", () => {
  test.use(authState ? { storageState: authState } : {});
  test.skip(!authState, "Set E2E_AUTH_STATE to a Playwright storage-state JSON file for authenticated workflow validation.");

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
});
