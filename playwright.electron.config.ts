import { defineConfig } from "@playwright/test";

/**
 * Electron end-to-end configuration, deliberately separate from
 * playwright.config.ts.
 *
 * The web config's "public" project uses `testIgnore` (a blocklist, not an
 * allowlist), so adding Electron specs under tests/e2e/ would have silently
 * enrolled them into the browser project and launched them in Chromium, where
 * `_electron.launch()` is meaningless. A separate testDir keeps the two suites
 * from contaminating each other.
 *
 * These specs assert the SECURITY POSTURE of the real packaged-shape app —
 * fuses, session policies, navigation and popup handlers, the single-instance
 * lock — by evaluating in the Electron main process. Source-string checks
 * (scripts/check-desktop-security.mjs) can only prove a string is present;
 * these prove the running application actually behaves that way.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e-electron",
  // Electron cold start plus a Next dev compile is slow; the web suite's 30s is
  // not enough and a flaky timeout here reads as a security regression.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // Electron tests share one app instance per spec and the single-instance lock
  // makes concurrent launches meaningless — run them serially.
  workers: 1,
  fullyParallel: false,
  use: {
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --hostname 127.0.0.1",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
