import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const authStatePath = process.env.E2E_AUTH_STATE ?? ".auth/e2e-user.json";

test("create authenticated storage state", async ({ page }) => {
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  if (!email || !password) {
    throw new Error("Set E2E_USER_EMAIL and E2E_USER_PASSWORD, or set E2E_AUTH_STATE to an existing Playwright storage-state file.");
  }

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await expect(page).toHaveURL(/\/(console|command)/, { timeout: 15_000 });

  fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
  await page.context().storageState({ path: authStatePath });
});
