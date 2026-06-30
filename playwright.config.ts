import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const authStatePath = process.env.E2E_AUTH_STATE ?? ".auth/e2e-user.json";
const authProjects = process.env.AXIS_E2E_AUTH
  ? [
      {
        name: "auth-setup",
        testMatch: /auth\.setup\.ts/,
      },
      {
        name: "authenticated",
        testMatch: /authenticated\.spec\.ts/,
        dependencies: process.env.E2E_AUTH_STATE ? [] : ["auth-setup"],
        use: { ...devices["Desktop Chrome"], storageState: authStatePath },
      },
    ]
  : [];

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --hostname 127.0.0.1",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "public",
      testIgnore: [/auth\.setup\.ts/, /authenticated\.spec\.ts/],
      use: { ...devices["Desktop Chrome"] },
    },
    ...authProjects,
  ],
});
