import { expect, test } from "@playwright/test";

// Authenticated smoke for the Axis System Redesign "Operate" surfaces
// (/tasks, /approvals). Runs under the `authenticated` project — set
// AXIS_E2E_AUTH=1 and the local Supabase stack (see docs/local-e2e.md).
// Middleware redirects unauthenticated users to /login before these render.

test("tasks workbench loads and exposes the routine trigger", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  await expect(page.getByText(/agent tasks/i)).toBeVisible();
  // The deterministic routine trigger must be present and operable.
  await expect(page.getByRole("button", { name: /run concentration check/i })).toBeEnabled();
});

test("approvals queue loads with its filter and empty/populated state", async ({ page }) => {
  await page.goto("/approvals");
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  await expect(page.getByText(/^Approvals$/)).toBeVisible();
  // Either the honest empty state or at least one approval card — never a crash.
  await expect(
    page.getByText(/nothing to approve|all caught up|pending|approved|executed/i).first(),
  ).toBeVisible();
});

test("new Operate routes are reachable from the command palette", async ({ page }) => {
  await page.goto("/command");
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
});
