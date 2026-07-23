import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * These exercise the CLI against real, disposable git histories. The checker
 * is deliberately a top-level command that shells out to git, so behavioral
 * fixtures are more valuable than source-pattern assertions: they prove the
 * acceptance boundary that CI will actually use.
 */

const SCRIPT_SOURCE = readFileSync(
  path.join(process.cwd(), "scripts/derive-program-state.mjs"),
  "utf8",
);
const TREE_INTEGRITY_SOURCE = readFileSync(
  path.join(process.cwd(), "scripts/state-tree-integrity.mjs"),
  "utf8",
);
const fixtures: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runState(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["scripts/derive-program-state.mjs", ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

function runStateWithEnv(
  cwd: string,
  args: string[],
  env: Record<string, string>,
) {
  return spawnSync(process.execPath, ["scripts/derive-program-state.mjs", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function commitFile(cwd: string, file: string, contents: string, subject: string) {
  const full = path.join(cwd, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", subject);
}

function makeFreshStateFixture(
  featureSubject = "feat: feature-branch state fixture",
  paddingMainCommits = 0,
) {
  const cwd = mkdtempSync(path.join(tmpdir(), "axis-state-"));
  fixtures.push(cwd);
  mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  mkdirSync(path.join(cwd, "docs"), { recursive: true });
  mkdirSync(path.join(cwd, ".claude/axis-redesign"), { recursive: true });
  mkdirSync(path.join(cwd, "supabase/migrations"), { recursive: true });
  mkdirSync(path.join(cwd, ".fake-bin"), { recursive: true });
  mkdirSync(path.join(cwd, "public/vector-assets/manifests"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts/derive-program-state.mjs"), SCRIPT_SOURCE);
  writeFileSync(path.join(cwd, "scripts/state-tree-integrity.mjs"), TREE_INTEGRITY_SOURCE);
  writeFileSync(
    path.join(cwd, "scripts/check-bundle-budget.mjs"),
    `if (process.env.AXIS_TEST_BUNDLE_FAIL === "1") process.exit(2);
console.log("Shared static JS: 10 KB / 20 KB");
console.log("Route-isolated game JS: 30 KB / 40 KB");\n`,
  );
  writeFileSync(
    path.join(cwd, ".fake-bin/npx"),
    `#!/bin/sh
if [ "$1" = "vitest" ]; then
  if [ "$AXIS_TEST_VITEST_FAIL" = "1" ]; then exit 1; fi
  printf '%s\\n' '{"success":true,"numFailedTests":0,"numPassedTests":2,"numTotalTests":2,"numTotalTestSuites":1,"testResults":[{}]}'
fi
exit 0
`,
  );
  writeFileSync(
    path.join(cwd, ".fake-bin/npm"),
    `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p .next/static/chunks
  mkdir -p public/vector-assets/manifests
  printf '%s\\n' overwritten > public/vector-assets/manifests/keep.ignored
  printf '%s\\n' emitted > public/vector-assets/manifests/new-build.ignored
  if [ "$AXIS_TEST_BUILD_FAIL" = "1" ]; then exit 1; fi
  if [ "$AXIS_TEST_BUILD_ID_ABSENT" != "1" ]; then printf '%s\\n' fixture-build > .next/BUILD_ID; fi
fi
exit 0
`,
  );
  chmodSync(path.join(cwd, ".fake-bin/npx"), 0o755);
  chmodSync(path.join(cwd, ".fake-bin/npm"), 0o755);
  writeFileSync(
    path.join(cwd, ".gitignore"),
    ".next/\npublic/vector-assets/manifests/*.ignored\n",
  );
  writeFileSync(
    path.join(cwd, "public/vector-assets/manifests/keep.ignored"),
    "pre-existing ignored content\n",
  );
  writeFileSync(path.join(cwd, "supabase/migrations/001_fixture.sql"), "select 1;\n");
  writeFileSync(
    path.join(cwd, ".claude/axis-redesign/PROGRAM_STATE.json"),
    `${JSON.stringify({ program: "fixture", waves: [] }, null, 2)}\n`,
  );

  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "AXIS test");
  git(cwd, "config", "user.email", "axis-test@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "chore: fixture bootstrap");

  commitFile(cwd, "merged-wave.txt", "merged wave\n", "feat: Wave 1.0 state fixture");
  for (let index = 0; index < paddingMainCommits; index += 1) {
    git(cwd, "commit", "--allow-empty", "-m", `chore: history padding ${index}`);
  }
  git(cwd, "checkout", "-b", "codex/state-fixture");
  commitFile(cwd, "feature.txt", "first feature change\n", featureSubject);
  const observedHead = git(cwd, "rev-parse", "HEAD");
  const derive = runState(cwd);
  expect(derive.status, derive.stderr).toBe(0);
  git(cwd, "add", "docs/CURRENT_STATE.md", ".claude/axis-redesign/GENERATED_STATE.json");
  git(cwd, "commit", "-m", "docs(state): refresh canonical state");

  return { cwd, observedHead };
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

describe("program state derivation", { timeout: 30_000 }, () => {
  it("accepts the one generated-state commit required by the normal feature-branch workflow", () => {
    const fixture = makeFreshStateFixture();

    // The generated document records the feature commit. Committing the two
    // generated artifacts creates its child without changing the committed-tree
    // fingerprint, the self-reference-safe shape of a usable PR workflow.
    const result = runState(fixture.cwd, "--check");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("agrees with the repository");
    expect(readFileSync(path.join(fixture.cwd, "docs/CURRENT_STATE.md"), "utf8")).toContain(
      "| 1.0 | local merge |",
    );
    expect(readFileSync(path.join(fixture.cwd, "docs/CURRENT_STATE.md"), "utf8")).toContain(
      "**State fingerprint:**",
    );
  });

  it("renders fixed eight-character commit prefixes independent of Git abbreviation settings", () => {
    const fixture = makeFreshStateFixture("feat: Wave 2.0 fixed SHA fixture");
    git(fixture.cwd, "config", "core.abbrev", "12");

    const derive = runState(fixture.cwd);
    expect(derive.status, derive.stderr).toBe(0);
    git(
      fixture.cwd,
      "add",
      "docs/CURRENT_STATE.md",
      ".claude/axis-redesign/GENERATED_STATE.json",
    );
    git(fixture.cwd, "commit", "-m", "docs(state): render fixed SHA prefixes");

    const generated = readFileSync(path.join(fixture.cwd, "docs/CURRENT_STATE.md"), "utf8");
    expect(generated).toMatch(/\| 1\.0 \| local merge \| `[0-9a-f]{8}` \|/);
    expect(generated).toMatch(/- `[0-9a-f]{8}` feat: Wave 2\.0 fixed SHA fixture/);

    git(fixture.cwd, "config", "core.abbrev", "4");
    const check = runState(fixture.cwd, "--check");

    expect(check.status, check.stderr).toBe(0);
  });

  it("scans the complete main history instead of forgetting waves older than 60 commits", () => {
    const fixture = makeFreshStateFixture("feat: feature after long history", 65);

    expect(
      readFileSync(path.join(fixture.cwd, "docs/CURRENT_STATE.md"), "utf8"),
    ).toContain("| 1.0 | local merge |");
  });

  it("prefers origin/main when both a remote-tracking and divergent local main exist", () => {
    const fixture = makeFreshStateFixture();
    git(fixture.cwd, "checkout", "main");
    git(
      fixture.cwd,
      "update-ref",
      "refs/remotes/origin/main",
      git(fixture.cwd, "rev-parse", "HEAD"),
    );
    commitFile(
      fixture.cwd,
      "local-only-wave.txt",
      "not on origin\n",
      "feat: Wave 9.9 local-only fixture",
    );
    mkdirSync(path.join(fixture.cwd, "docs"), { recursive: true });

    const result = runState(fixture.cwd);

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(path.join(fixture.cwd, "docs/CURRENT_STATE.md"), "utf8"),
    ).not.toContain("| 9.9 |");
  });

  it("hard-fails in a single-branch shallow feature clone with no reviewed main ref", () => {
    const source = makeFreshStateFixture();
    const shallow = mkdtempSync(path.join(tmpdir(), "axis-state-no-main-"));
    fixtures.push(shallow);
    rmSync(shallow, { recursive: true, force: true });
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        "codex/state-fixture",
        `file://${source.cwd}`,
        shallow,
      ],
      { encoding: "utf8" },
    );
    const canonical = path.join(shallow, "docs/CURRENT_STATE.md");
    const before = readFileSync(canonical, "utf8");

    expect(
      spawnSync("git", ["rev-parse", "--verify", "main"], {
        cwd: shallow,
        encoding: "utf8",
      }).status,
    ).not.toBe(0);
    expect(
      spawnSync("git", ["rev-parse", "--verify", "origin/main"], {
        cwd: shallow,
        encoding: "utf8",
      }).status,
    ).not.toBe(0);
    const result = runState(shallow);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires a reviewed main ref");
    expect(readFileSync(canonical, "utf8")).toBe(before);
  });

  it("remains current after a protected merge commit with identical repository content", () => {
    const fixture = makeFreshStateFixture();
    git(fixture.cwd, "checkout", "main");
    git(fixture.cwd, "merge", "--no-ff", "codex/state-fixture", "-m", "Merge PR state fixture");

    const result = runState(fixture.cwd, "--check");

    expect(result.status, result.stderr).toBe(0);
    expect(git(fixture.cwd, "rev-parse", "HEAD")).not.toBe(fixture.observedHead);
  });

  it("remains current after a protected squash merge with identical repository content", () => {
    const fixture = makeFreshStateFixture();
    git(fixture.cwd, "checkout", "main");
    git(fixture.cwd, "merge", "--squash", "codex/state-fixture");
    git(fixture.cwd, "commit", "-m", "Squash merge PR state fixture");

    const result = runState(fixture.cwd, "--check");

    expect(result.status, result.stderr).toBe(0);
    expect(git(fixture.cwd, "rev-parse", "HEAD")).not.toBe(fixture.observedHead);
    expect(
      readFileSync(path.join(fixture.cwd, "docs/CURRENT_STATE.md"), "utf8"),
    ).not.toContain("Production state base:");
  });

  it.each(["merge commit", "squash merge"])(
    "requires a protected state refresh when a %s introduces a new numeric wave",
    (strategy) => {
      const fixture = makeFreshStateFixture("feat: Wave 2.0 feature fixture");
      git(fixture.cwd, "checkout", "main");
      if (strategy === "merge commit") {
        git(
          fixture.cwd,
          "merge",
          "--no-ff",
          "codex/state-fixture",
          "-m",
          "Merge Wave 2.0 state fixture",
        );
      } else {
        git(fixture.cwd, "merge", "--squash", "codex/state-fixture");
        git(fixture.cwd, "commit", "-m", "feat: Wave 2.0 squash merge fixture");
      }

      const result = runState(fixture.cwd, "--check");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("generated block differs from the deterministic state");
      expect(result.stderr).toContain("| 2.0 |");
    },
  );

  it("rejects an ancestor snapshot after a real feature commit", () => {
    const fixture = makeFreshStateFixture();
    commitFile(fixture.cwd, "second-feature.txt", "unrecorded\n", "feat: unrecorded work");

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated block differs from the deterministic state");
    expect(result.stderr).toContain("State fingerprint");
  });

  it("rejects a stale tracked-migration count even when the recorded HEAD is current", () => {
    const fixture = makeFreshStateFixture();
    const canonical = path.join(fixture.cwd, "docs/CURRENT_STATE.md");
    writeFileSync(
      canonical,
      readFileSync(canonical, "utf8").replace("**Tracked migrations:** 1", "**Tracked migrations:** 0"),
    );

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated block differs from the deterministic state");
    expect(result.stderr).toContain("Tracked migrations");
  });

  it("rejects an omitted merged wave even when the recorded HEAD is current", () => {
    const fixture = makeFreshStateFixture();
    const canonical = path.join(fixture.cwd, "docs/CURRENT_STATE.md");
    writeFileSync(canonical, readFileSync(canonical, "utf8").replace(/^\| 1\.0 \|.*\n/m, ""));

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated block differs from the deterministic state");
    expect(result.stderr).toContain("| 1.0 | local merge |");
  });

  it.each([
    {
      field: "PR",
      mutate: (text: string) => text.replace("| 1.0 | local merge |", "| 1.0 | #999 |"),
      evidence: "#999",
    },
    {
      field: "commit SHA",
      mutate: (text: string) =>
        text.replace(/(\| 1\.0 \| local merge \| `)[0-9a-f]+(` \|)/, "$1deadbeef$2"),
      evidence: "deadbeef",
    },
    {
      field: "subject",
      mutate: (text: string) =>
        text.replace("feat: Wave 1.0 state fixture", "feat: fabricated wave provenance"),
      evidence: "fabricated wave provenance",
    },
  ])("rejects an altered merged-wave $field", ({ mutate, evidence }) => {
    const fixture = makeFreshStateFixture();
    const canonical = path.join(fixture.cwd, "docs/CURRENT_STATE.md");
    writeFileSync(canonical, mutate(readFileSync(canonical, "utf8")));

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated block differs from the deterministic state");
    expect(result.stderr).toContain(evidence);
  });

  it.each([
    {
      field: "defect count",
      mutate: (text: string) => text.replace("**Total logged:** 0", "**Total logged:** 99"),
      evidence: "Total logged",
    },
    {
      field: "gate claim",
      mutate: (text: string) =>
        text.replace(
          "- _never measured; run with --gates_",
          "- **Tests:** 999/999 across 1 files",
        ),
      evidence: "Tests",
    },
    {
      field: "source branch",
      mutate: (text: string) =>
        text.replace("**Branch:** `codex/state-fixture`", "**Branch:** `tampered`"),
      evidence: "Branch",
    },
    {
      field: "source HEAD",
      mutate: (text: string) =>
        text.replace(/\*\*HEAD:\*\* `[0-9a-f]{8}`/, "**HEAD:** `deadbeef`"),
      evidence: "deadbeef",
    },
    {
      field: "source main",
      mutate: (text: string) =>
        text.replace(/\*\*main:\*\* `[0-9a-f]{8}`/, "**main:** `deadbeef`"),
      evidence: "deadbeef",
    },
  ])("rejects a tampered generated $field", ({ mutate, evidence }) => {
    const fixture = makeFreshStateFixture();
    const canonical = path.join(fixture.cwd, "docs/CURRENT_STATE.md");
    writeFileSync(canonical, mutate(readFileSync(canonical, "utf8")));

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated block differs from the deterministic state");
    expect(result.stderr).toContain(evidence);
  });

  it("binds persisted gate evidence into the fingerprint", () => {
    const fixture = makeFreshStateFixture();
    const generatedJson = path.join(
      fixture.cwd,
      ".claude/axis-redesign/GENERATED_STATE.json",
    );
    const snapshot = JSON.parse(readFileSync(generatedJson, "utf8"));
    snapshot.gates = {
      measured: true,
      measuredAt: "2026-07-22T00:00:00.000Z",
      tests: { passed: 999, total: 999, files: 1, suites: 1 },
    };
    writeFileSync(generatedJson, `${JSON.stringify(snapshot, null, 2)}\n`);

    const canonical = path.join(fixture.cwd, "docs/CURRENT_STATE.md");
    writeFileSync(
      canonical,
      readFileSync(canonical, "utf8").replace(
        "- _never measured; run with --gates_",
        "- **Tests:** 999/999 across 1 files\n- **Measured at:** 2026-07-22T00:00:00.000Z",
      ),
    );
    git(fixture.cwd, "add", generatedJson, canonical);
    git(fixture.cwd, "commit", "-m", "docs(state): tamper gate evidence");

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated block differs from the deterministic state");
    expect(result.stderr).toContain("State fingerprint");
  });

  it("includes authored PROGRAM_STATE policy in the content-integrity boundary", () => {
    const fixture = makeFreshStateFixture();
    commitFile(
      fixture.cwd,
      ".claude/axis-redesign/PROGRAM_STATE.json",
      `${JSON.stringify({ program: "tampered", waves: [] }, null, 2)}\n`,
      "docs: change authored policy without refreshing state",
    );

    const result = runState(fixture.cwd, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("State fingerprint");
  });

  it("records local source-gate evidence only after the complete contract passes", () => {
    const fixture = makeFreshStateFixture();
    const result = runStateWithEnv(
      fixture.cwd,
      ["--gates"],
      { PATH: `${path.join(fixture.cwd, ".fake-bin")}:${process.env.PATH}` },
    );

    expect(result.status, result.stderr).toBe(0);
    const snapshot = JSON.parse(
      readFileSync(
        path.join(fixture.cwd, ".claude/axis-redesign/GENERATED_STATE.json"),
        "utf8",
      ),
    );
    expect(snapshot.gates).toMatchObject({
      measured: true,
      typecheck: { passed: true },
      lint: { passed: true },
      tests: { passed: 2, total: 2 },
      build: { passed: true, cleanOutput: true },
      bundleKb: { used: 10, budget: 20 },
      routeIsolatedBundleKb: { used: 30, budget: 40 },
    });
    expect(
      readFileSync(
        path.join(
          fixture.cwd,
          "public/vector-assets/manifests/keep.ignored",
        ),
        "utf8",
      ),
    ).toBe("pre-existing ignored content\n");
    expect(
      existsSync(
        path.join(
          fixture.cwd,
          "public/vector-assets/manifests/new-build.ignored",
        ),
      ),
    ).toBe(false);
  });

  it("preserves measured gate evidence across an identical-content state refresh", () => {
    const fixture = makeFreshStateFixture();
    const gateEnv = {
      PATH: `${path.join(fixture.cwd, ".fake-bin")}:${process.env.PATH}`,
    };
    const measured = runStateWithEnv(fixture.cwd, ["--gates"], gateEnv);
    expect(measured.status, measured.stderr).toBe(0);
    const generatedPath = path.join(
      fixture.cwd,
      ".claude/axis-redesign/GENERATED_STATE.json",
    );
    const before = JSON.parse(readFileSync(generatedPath, "utf8")).gates;

    const refreshed = runState(fixture.cwd);
    expect(refreshed.status, refreshed.stderr).toBe(0);
    const refreshedSnapshot = JSON.parse(readFileSync(generatedPath, "utf8"));
    const after = refreshedSnapshot.gates;

    expect(after).toEqual(before);
    expect(after.measured).toBe(true);
    expect(after.sourceContentTreeHash).toBe(
      refreshedSnapshot.git.contentTreeHash,
    );
  });

  it.each([
    ["Vitest failure", { AXIS_TEST_VITEST_FAIL: "1" }, "vitest"],
    ["build failure", { AXIS_TEST_BUILD_FAIL: "1" }, "build"],
    ["missing build output", { AXIS_TEST_BUILD_ID_ABSENT: "1" }, "BUILD_ID"],
    ["bundle failure", { AXIS_TEST_BUNDLE_FAIL: "1" }, "bundle"],
  ])(
    "fails closed without writing a measured snapshot on %s",
    (_name, fault, evidence) => {
      const fixture = makeFreshStateFixture();
      const generatedPath = path.join(
        fixture.cwd,
        ".claude/axis-redesign/GENERATED_STATE.json",
      );
      const canonicalPath = path.join(fixture.cwd, "docs/CURRENT_STATE.md");
      const beforeGenerated = readFileSync(generatedPath, "utf8");
      const beforeCanonical = readFileSync(canonicalPath, "utf8");
      const result = runStateWithEnv(
        fixture.cwd,
        ["--gates"],
        {
          PATH: `${path.join(fixture.cwd, ".fake-bin")}:${process.env.PATH}`,
          ...fault,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(evidence);
      expect(readFileSync(generatedPath, "utf8")).toBe(beforeGenerated);
      expect(readFileSync(canonicalPath, "utf8")).toBe(beforeCanonical);
    },
  );
});
