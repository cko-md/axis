import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_AUTH = process.env.AXIS_E2E_AUTH;
const ORIGINAL_STATE = process.env.E2E_AUTH_STATE;

afterEach(() => {
  if (ORIGINAL_AUTH === undefined) delete process.env.AXIS_E2E_AUTH;
  else process.env.AXIS_E2E_AUTH = ORIGINAL_AUTH;
  if (ORIGINAL_STATE === undefined) delete process.env.E2E_AUTH_STATE;
  else process.env.E2E_AUTH_STATE = ORIGINAL_STATE;
  vi.resetModules();
});

describe("Playwright authenticated project wiring", () => {
  it("runs auth setup when CI has credentials but no pre-existing state file", async () => {
    process.env.AXIS_E2E_AUTH = "1";
    delete process.env.E2E_AUTH_STATE;
    vi.resetModules();

    const { default: config } = await import("../../../playwright.config");
    const authenticated = config.projects?.find(
      (project) => typeof project !== "string" && project.name === "authenticated",
    );

    expect(authenticated).toMatchObject({
      dependencies: ["auth-setup"],
    });
  });

  it("skips auth setup only when an explicit storage-state path is supplied", async () => {
    process.env.AXIS_E2E_AUTH = "1";
    process.env.E2E_AUTH_STATE = "/tmp/existing-auth-state.json";
    vi.resetModules();

    const { default: config } = await import("../../../playwright.config");
    const authenticated = config.projects?.find(
      (project) => typeof project !== "string" && project.name === "authenticated",
    );

    expect(authenticated).toMatchObject({
      dependencies: [],
    });
  });

  it("includes every authenticated spec suffix in the authenticated project", async () => {
    process.env.AXIS_E2E_AUTH = "1";
    delete process.env.E2E_AUTH_STATE;
    vi.resetModules();

    const { default: config } = await import("../../../playwright.config");
    const authenticated = config.projects?.find(
      (project) => typeof project !== "string" && project.name === "authenticated",
    );
    const testMatch = authenticated && typeof authenticated !== "string"
      ? authenticated.testMatch
      : undefined;

    expect(testMatch).toBeInstanceOf(RegExp);
    for (const file of [
      "authenticated.spec.ts",
      "operate-authenticated.spec.ts",
      "theme-preferences-authenticated.spec.ts",
      "workspace-authenticated.spec.ts",
    ]) {
      expect((testMatch as RegExp).test(file), file).toBe(true);
    }
    expect((testMatch as RegExp).test("auth.setup.ts")).toBe(false);
  });
});
