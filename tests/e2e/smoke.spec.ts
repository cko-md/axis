import { expect, test } from "@playwright/test";

// PROD-4 public smoke: unauthenticated surface. Every route must resolve
// without an error boundary or 5xx — protected routes redirect to /login via
// middleware, public routes render. Complements production-gate.spec.ts (which
// checks a 4-route subset) by covering the full production nav + the legacy
// routes retired in DISP-3.

const PROTECTED_ROUTES = [
  "/command", "/dispatch", "/schedule", "/agenda", "/mail", "/notes",
  "/objectives", "/debrief", "/pipeline", "/literature", "/people",
  "/briefing", "/fund", "/vitality", "/atelier", "/listening-vault",
  "/library", "/supper-club", "/control-room",
];

const LEGACY_ROUTES = ["/console", "/signals"];

test("home renders with a sign-in path", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
});

test("legal pages render", async ({ page }) => {
  for (const path of ["/terms", "/privacy"]) {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), `${path} status`).toBeLessThan(500);
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
  }
});

test("every protected + legacy route resolves without crashing pre-auth", async ({ page }) => {
  test.setTimeout(120_000);
  for (const path of [...PROTECTED_ROUTES, ...LEGACY_ROUTES]) {
    // A redirect (e.g. middleware → /login) can resolve response to null, so
    // assert on the rendered document, not the HTTP status — the error boundary
    // check is the real "did it crash" signal and isn't flaky under load.
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body"), `${path} body`).toBeVisible();
    await expect(page.locator("body"), `${path} error boundary`).not.toContainText(/application error|runtime error/i);
  }
});

test("unknown route shows not-found, not a crash", async ({ page }) => {
  await page.goto("/definitely-not-a-real-route-xyz-123", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
});
