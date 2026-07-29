import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const playwrightConfig = readFileSync(join(root, "playwright.config.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("required browser-gate focus policy", () => {
  it("fails focused suites in the shared CI-aware configuration", () => {
    expect(playwrightConfig).toContain("forbidOnly: isCi || process.env.AXIS_FORBID_FOCUSED_TESTS === \"1\"");
  });

  it("passes --forbid-only to both mandatory browser jobs and package commands", () => {
    expect(workflow).toContain("npx playwright test --project=public --fail-on-flaky-tests --forbid-only");
    expect(workflow).toContain("npx playwright test --project=authenticated --fail-on-flaky-tests --forbid-only");
    expect(packageJson.scripts["test:e2e"]).toContain("--forbid-only");
    expect(packageJson.scripts["test:e2e:auth"]).toContain("--forbid-only");
  });
});
