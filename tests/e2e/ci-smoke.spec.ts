import { expect, test } from "@playwright/test";

/**
 * Minimal public smoke that runs in CI (no auth, no seeded data). It boots the
 * app with placeholder Supabase env and asserts the login page renders with its
 * form and without a runtime error / uncaught page error. Deliberately narrow so
 * it is reliable in CI; the fuller authenticated flows live in operate.spec.ts /
 * authenticated.spec.ts and run against the local Supabase stack.
 */
test("login page renders its form without runtime errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/login");

  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  // A login form must render at least one input (email/password).
  await expect(page.locator("input").first()).toBeVisible();

  expect(pageErrors, `Uncaught page errors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});
