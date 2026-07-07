import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const authStatePath = process.env.E2E_AUTH_STATE ?? ".auth/e2e-user.json";

test("create authenticated storage state", async ({ page }) => {
  // Dev-mode cold-compiles /login and repeats the sign-in retry loop below, so
  // give this setup step generous headroom (the default 30s is too tight).
  test.setTimeout(120_000);

  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  if (!email || !password) {
    throw new Error("Set E2E_USER_EMAIL and E2E_USER_PASSWORD, or set E2E_AUTH_STATE to an existing Playwright storage-state file.");
  }

  // The login form's inputs have no `name` attribute, so if the submit button is
  // clicked before React finishes hydrating (dev-mode cold compiles /login for
  // several seconds), the browser performs a NATIVE GET submit to `/login?` with
  // an empty query and the SPA handler never runs. Guard against that hydration
  // race with a retry loop that treats "still on /login" as a not-yet-hydrated
  // retry rather than a failure. (Production hydration is fast; real users never
  // hit this.) Note: `networkidle` is unreliable against a dev server because the
  // HMR websocket never goes idle — wait on concrete elements instead.
  const emailBox = page.getByPlaceholder("Email");
  const passwordBox = page.getByPlaceholder("Password");
  const signInBtn = page.getByRole("button", { name: /^Sign in$/ });

  // Success signal = the Supabase auth cookie being set, NOT the client-side
  // redirect. Decoupling the two makes this robust against dev-server flakiness
  // (Fast Refresh rebuilds can reset hydration mid-flow and race the redirect).
  const hasAuthCookie = async () =>
    (await page.context().cookies()).some((c) => /^sb-.*-auth-token/.test(c.name));

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(signInBtn).toBeEnabled();

  // Time-bounded loop: re-attempt fill+click until the auth cookie appears. This
  // absorbs both the cold-compile delay (first /login compile can exceed 10s) and
  // the hydration race (a click before hydration native-submits to /login? and is
  // a no-op). Each iteration gives hydration a moment, submits, then checks.
  let signedIn = false;
  const deadline = Date.now() + 90_000;
  while (!signedIn && Date.now() < deadline) {
    if (!/\/login/.test(page.url())) await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_500);
    await emailBox.fill(email).catch(() => {});
    await passwordBox.fill(password).catch(() => {});
    await signInBtn.click().catch(() => {});
    for (let i = 0; i < 6 && !signedIn; i++) {
      await page.waitForTimeout(1_000);
      if (await hasAuthCookie()) signedIn = true;
    }
  }

  expect(signedIn, "Supabase auth cookie was set after sign-in").toBe(true);

  // Cookie is set — land on an authenticated route deterministically (middleware
  // now recognizes the session) rather than depending on the client redirect.
  await page.goto("/command", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/(console|command)/, { timeout: 15_000 });

  fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
  await page.context().storageState({ path: authStatePath });
});
