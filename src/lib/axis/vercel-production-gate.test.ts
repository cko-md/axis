import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitTreeContentHash,
  stateEvidenceFingerprint,
} from "../../../scripts/state-tree-integrity.mjs";

const IGNORE_SOURCE = readFileSync(
  path.join(process.cwd(), "scripts/vercel-ignore-build.mjs"),
  "utf8",
);
const WRAPPER_SOURCE = readFileSync(
  path.join(process.cwd(), "scripts/vercel-ignore-build.sh"),
  "utf8",
);
const INTEGRITY_SOURCE = readFileSync(
  path.join(process.cwd(), "scripts/state-tree-integrity.mjs"),
  "utf8",
);
const OUTER_IGNORE_COMMAND = JSON.parse(
  readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"),
).ignoreCommand as string;
const fixtures: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "axis-vercel-state-"));
  fixtures.push(cwd);
  mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  mkdirSync(path.join(cwd, ".claude/axis-redesign"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts/vercel-ignore-build.mjs"), IGNORE_SOURCE);
  writeFileSync(path.join(cwd, "scripts/vercel-ignore-build.sh"), WRAPPER_SOURCE);
  writeFileSync(path.join(cwd, "scripts/state-tree-integrity.mjs"), INTEGRITY_SOURCE);
  writeFileSync(
    path.join(cwd, ".claude/axis-redesign/PROGRAM_STATE.json"),
    '{"program":"fixture"}\n',
  );
  writeFileSync(path.join(cwd, "feature.txt"), "source\n");
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "AXIS test");
  git(cwd, "config", "user.email", "axis-test@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "feat: Wave 1.0 production fixture");
  return cwd;
}

function recordState(cwd: string, sourceMainContentTreeHash: string) {
  const contentTreeHash = gitTreeContentHash({ cwd, ref: "HEAD" });
  const provenance = {
    branch: "codex/state-refresh",
    head: git(cwd, "rev-parse", "HEAD"),
    mainHead: git(cwd, "rev-parse", "HEAD"),
    workingTreeClean: true,
    aheadOfMain: [],
  };
  const gates = {
    measured: true,
    sourceContentTreeHash: contentTreeHash,
    sourceHead: provenance.head,
    typecheck: { passed: true },
    lint: { passed: true },
    tests: { passed: 1, total: 1 },
    build: { passed: true },
    bundleKb: { used: 10, budget: 20 },
    routeIsolatedBundleKb: { used: 30, budget: 40 },
  };
  const fingerprint = stateEvidenceFingerprint(contentTreeHash, {
    gates,
    provenance,
    sourceMainContentTreeHash,
  });
  writeFileSync(
    path.join(cwd, ".claude/axis-redesign/GENERATED_STATE.json"),
    `${JSON.stringify({
      git: {
        ...provenance,
        contentTreeHash,
        sourceMainContentTreeHash,
        fingerprint,
      },
      gates,
    }, null, 2)}\n`,
  );
  git(cwd, "add", ".claude/axis-redesign/GENERATED_STATE.json");
  git(cwd, "commit", "-m", "docs(state): refresh canonical state");
  return contentTreeHash;
}

function shallowClone(source: string) {
  const shallow = mkdtempSync(path.join(tmpdir(), "axis-vercel-shallow-"));
  fixtures.push(shallow);
  rmSync(shallow, { recursive: true, force: true });
  execFileSync(
    "git",
    ["clone", "--quiet", "--depth", "1", `file://${source}`, shallow],
    { encoding: "utf8" },
  );
  return shallow;
}

function runGate(cwd: string, vercelEnv?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VERCEL_ENV;
  if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv;
  return spawnSync("sh", ["-c", OUTER_IGNORE_COMMAND], {
    cwd,
    encoding: "utf8",
    env,
  });
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

describe("Vercel canonical-state production gate", { timeout: 30_000 }, () => {
  it("always continues preview builds even when state evidence is absent", () => {
    const cwd = makeFixture();
    const result = runGate(cwd, "preview");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("preview/development");
  });

  it.each([undefined, "", "staging", "unexpected"])(
    "fails closed for a missing or unknown VERCEL_ENV (%s)",
    (vercelEnv) => {
      const cwd = makeFixture();
      const result = runGate(cwd, vercelEnv);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("VERCEL_ENV is missing or unknown");
    },
  );

  it.each([
    {
      failure: "syntax",
      arrange: (cwd: string) =>
        writeFileSync(
          path.join(cwd, "scripts/vercel-ignore-build.mjs"),
          "const broken = ;\n",
        ),
    },
    {
      failure: "import",
      arrange: (cwd: string) =>
        rmSync(path.join(cwd, "scripts/state-tree-integrity.mjs")),
    },
    {
      failure: "runtime after a spoofed sentinel",
      arrange: (cwd: string) =>
        writeFileSync(
          path.join(cwd, "scripts/vercel-ignore-build.mjs"),
          'console.log("AXIS_VERCEL_DECISION=BUILD");\nthrow new Error("unexpected runtime failure");\n',
        ),
    },
  ])("fails closed when the Node policy has a $failure failure", ({ arrange }) => {
    const cwd = makeFixture();
    arrange(cwd);

    const result = runGate(cwd, "production");

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(
      "canonical state is aligned; protected release-governance",
    );
  });

  it.each([
    {
      failure: "missing",
      arrange: (cwd: string) =>
        rmSync(path.join(cwd, "scripts/vercel-ignore-build.sh")),
    },
    {
      failure: "syntax-invalid",
      arrange: (cwd: string) =>
        writeFileSync(
          path.join(cwd, "scripts/vercel-ignore-build.sh"),
          "if then\n",
        ),
    },
  ])("fails closed when the shell wrapper is $failure", ({ arrange }) => {
    const cwd = makeFixture();
    arrange(cwd);

    const result = runGate(cwd, "production");

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("canonical state is aligned");
  });

  it("skips the first production attempt for source derived ahead of main", () => {
    const cwd = makeFixture();
    recordState(cwd, "0".repeat(64));
    const result = runGate(cwd, "production");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("merge a state refresh");
  });

  it("treats a self-consistent candidate snapshot as consistency evidence, not attestation", () => {
    const cwd = makeFixture();
    const current = gitTreeContentHash({ cwd, ref: "HEAD" });
    // These claimed passes are deliberately synthetic. The deterministic
    // fingerprint can prove internal consistency but cannot prove these
    // commands ran. Protected release-governance + hosted checks provide that
    // authority before this candidate can reach main.
    recordState(cwd, current);
    const result = runGate(cwd, "production");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "external owner-controlled release authorization remains required",
    );
  });

  it("fails closed when authored PROGRAM_STATE policy changes after derivation", () => {
    const cwd = makeFixture();
    const current = gitTreeContentHash({ cwd, ref: "HEAD" });
    recordState(cwd, current);
    writeFileSync(
      path.join(cwd, ".claude/axis-redesign/PROGRAM_STATE.json"),
      '{"program":"changed-after-state"}\n',
    );
    git(cwd, "add", ".claude/axis-redesign/PROGRAM_STATE.json");
    git(cwd, "commit", "-m", "docs: change release policy");

    const result = runGate(cwd, "production");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("does not describe this source tree");
  });

  it("skips aligned production when local gate evidence is stale", () => {
    const cwd = makeFixture();
    const current = gitTreeContentHash({ cwd, ref: "HEAD" });
    recordState(cwd, current);
    const generated = path.join(
      cwd,
      ".claude/axis-redesign/GENERATED_STATE.json",
    );
    const snapshot = JSON.parse(readFileSync(generated, "utf8"));
    snapshot.gates.measured = false;
    snapshot.git.fingerprint = stateEvidenceFingerprint(current, {
      gates: snapshot.gates,
      provenance: {
        branch: snapshot.git.branch,
        head: snapshot.git.head,
        mainHead: snapshot.git.mainHead,
        workingTreeClean: snapshot.git.workingTreeClean,
        aheadOfMain: snapshot.git.aheadOfMain,
      },
      sourceMainContentTreeHash: current,
    });
    writeFileSync(generated, `${JSON.stringify(snapshot, null, 2)}\n`);
    git(cwd, "add", generated);
    git(cwd, "commit", "-m", "docs(state): stale local gates");

    const result = runGate(cwd, "production");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local source gates are stale");
  });

  it("allows an aligned state refresh from a depth-one Vercel-style clone", () => {
    const source = makeFixture();
    const current = gitTreeContentHash({ cwd: source, ref: "HEAD" });
    recordState(source, current);
    const shallow = shallowClone(source);

    expect(git(shallow, "rev-list", "--count", "HEAD")).toBe("1");
    const result = runGate(shallow, "production");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("canonical state is aligned");
  });

  it("skips a numeric-wave production merge, builds its preview, then builds the protected state refresh in shallow clones", () => {
    const source = makeFixture();
    recordState(source, "0".repeat(64));
    const firstProduction = shallowClone(source);

    expect(runGate(firstProduction, "preview").status).toBe(1);
    expect(runGate(firstProduction, "production").status).toBe(0);

    const updatedMainTree = gitTreeContentHash({ cwd: source, ref: "HEAD" });
    recordState(source, updatedMainTree);
    const refreshedProduction = shallowClone(source);

    expect(git(refreshedProduction, "rev-list", "--count", "HEAD")).toBe("1");
    expect(runGate(refreshedProduction, "production").status).toBe(1);
  });
});
