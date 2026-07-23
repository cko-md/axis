import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  gitTreeContentHash,
  stateEvidenceFingerprint,
} from "../../../scripts/state-tree-integrity.mjs";
import {
  checksum,
  collectMigrationEntries,
  findMutableGitHubActionReferences,
  findSecondaryVercelProductionDeploys,
  FORBIDDEN_GATE_OVERRIDE_PATHS,
  resolveProtectedBaselineRevision,
  TRUSTED_CONTROL_BOOTSTRAP_FILES,
  TRUSTED_CONTROL_PLANE_FILES,
  validateAppendOnlyMigrationManifest,
  validateCandidateReleaseGovernance,
  validateMigrationManifest,
  validateReleaseGovernanceWorkflow,
} from "../../../scripts/release-validation-core.mjs";

type MigrationEntry = {
  version: string;
  file: string;
  sha256: string;
};

const root = process.cwd();
const migrationDirectory = join(root, "supabase", "migrations");
const manifestPath = join(root, "scripts", "release-migration-manifest.json");

function committedManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function actualMigrations() {
  return collectMigrationEntries(migrationDirectory);
}

function synchronizedManifest(entries: MigrationEntry[]) {
  return {
    schemaVersion: 1,
    migrationCount: entries.length,
    latest: entries.at(-1),
    migrations: entries,
  };
}

function protectedLedgerFixture() {
  return synchronizedManifest([
    {
      version: "20260701000000",
      file: "supabase/migrations/20260701000000_alpha.sql",
      sha256: "a".repeat(64),
    },
    {
      version: "20260702000000",
      file: "supabase/migrations/20260702000000_bravo.sql",
      sha256: "b".repeat(64),
    },
    {
      version: "20260703000000",
      file: "supabase/migrations/20260703000000_charlie.sql",
      sha256: "c".repeat(64),
    },
  ]);
}

function withMigrationFixture(run: (directory: string) => void) {
  const fixture = mkdtempSync(join(tmpdir(), "axis-migrations-"));
  try {
    writeFileSync(join(fixture, "20260722000000_valid_migration.sql"), "select 1;\n");
    run(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function withGitHistory(
  run: (fixture: { root: string; base: string; head: string }) => void,
) {
  const fixture = mkdtempSync(join(tmpdir(), "axis-release-git-"));
  try {
    git(fixture, "init");
    git(fixture, "config", "user.name", "AXIS Release Test");
    git(fixture, "config", "user.email", "release-test@example.invalid");
    writeFileSync(join(fixture, "state.txt"), "base\n");
    git(fixture, "add", "state.txt");
    git(fixture, "commit", "-m", "reviewed base");
    const base = git(fixture, "rev-parse", "HEAD");
    writeFileSync(join(fixture, "state.txt"), "candidate\n");
    git(fixture, "commit", "-am", "candidate");
    const head = git(fixture, "rev-parse", "HEAD");
    run({ root: fixture, base, head });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function withCandidateTrees(
  run: (fixture: { baseRoot: string; candidateRoot: string }) => void,
) {
  const fixture = mkdtempSync(join(tmpdir(), "axis-release-candidate-"));
  const baseRoot = join(fixture, "base");
  const candidateRoot = join(fixture, "candidate");
  try {
    for (const tree of [baseRoot, candidateRoot]) {
      mkdirSync(join(tree, "supabase", "migrations"), { recursive: true });
      mkdirSync(join(tree, "scripts"), { recursive: true });
      mkdirSync(join(tree, ".github", "workflows"), { recursive: true });
      mkdirSync(join(tree, ".claude", "axis-redesign"), { recursive: true });
      mkdirSync(join(tree, "src"), { recursive: true });
      mkdirSync(join(tree, "tests", "e2e"), { recursive: true });
      mkdirSync(join(tree, "electron"), { recursive: true });
    }
    const migration = "select 1;\n";
    const migrationName = "20260701000000_alpha.sql";
    const entry = {
      version: "20260701000000",
      file: `supabase/migrations/${migrationName}`,
      sha256: checksum(migration),
    };
    for (const tree of [baseRoot, candidateRoot]) {
      writeFileSync(
        join(tree, "supabase", "migrations", migrationName),
        migration,
      );
      writeFileSync(
        join(tree, "scripts", "release-migration-manifest.json"),
        JSON.stringify(synchronizedManifest([entry])),
      );
      for (const file of TRUSTED_CONTROL_PLANE_FILES) {
        mkdirSync(dirname(join(tree, file)), { recursive: true });
        cpSync(join(root, file), join(tree, file));
      }
      writeFileSync(
        join(tree, "src", "protected-gate.test.ts"),
        "export const protectedGateFixture = true;\n",
      );
      writeFileSync(
        join(tree, "tests", "e2e", "protected.spec.ts"),
        "export const protectedBrowserFixture = true;\n",
      );
      writeFileSync(
        join(tree, "electron", "protected.test.cjs"),
        "module.exports = true;\n",
      );
      git(tree, "init");
      git(tree, "config", "user.name", "AXIS Release Test");
      git(tree, "config", "user.email", "release-test@example.invalid");
      git(tree, "add", ".");
      git(tree, "commit", "-m", "source");
    }
    writeSynchronizedGeneratedState(baseRoot, candidateRoot);
    run({ baseRoot, candidateRoot });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function writeSynchronizedGeneratedState(
  baseRoot: string,
  candidateRoot: string,
) {
  git(candidateRoot, "add", ".");
  if (git(candidateRoot, "status", "--porcelain")) {
    git(candidateRoot, "commit", "-m", "candidate source change");
  }
  const baseHash = gitTreeContentHash({ cwd: baseRoot, ref: "HEAD" });
  const candidateHash = gitTreeContentHash({ cwd: candidateRoot, ref: "HEAD" });
  const gates = {
    measured: true,
    measuredAt: "2026-07-22T00:00:00.000Z",
    contract:
      "exact committed source: typecheck, lint, full unit suite, clean Next production build, aggregate bundle budget",
    sourceContentTreeHash: candidateHash,
    typecheck: { passed: true },
    lint: { passed: true },
    build: { passed: true, cleanOutput: true },
    tests: { passed: 1, total: 1, files: 1, suites: 1 },
    bundleKb: { used: 1, budget: 2 },
    routeIsolatedBundleKb: { used: 1, budget: 2 },
  };
  const baseProvenance = {
    branch: "main",
    head: "base",
    mainHead: "base",
    workingTreeClean: true,
    aheadOfMain: [],
  };
  const baseSnapshot = {
    git: {
      ...baseProvenance,
      contentTreeHash: baseHash,
      sourceMainContentTreeHash: baseHash,
      fingerprint: stateEvidenceFingerprint(baseHash, {
        gates,
        provenance: baseProvenance,
        sourceMainContentTreeHash: baseHash,
      }),
    },
    gates,
  };
  writeFileSync(
    join(baseRoot, ".claude", "axis-redesign", "GENERATED_STATE.json"),
    JSON.stringify(baseSnapshot),
  );
  git(baseRoot, "add", ".");
  git(baseRoot, "commit", "-m", "base state");

  const candidateProvenance = {
    branch: "candidate",
    head: "candidate",
    mainHead: "base",
    workingTreeClean: true,
    aheadOfMain: [],
  };
  const candidateSnapshot = {
    git: {
      ...candidateProvenance,
      contentTreeHash: candidateHash,
      sourceMainContentTreeHash: baseHash,
      fingerprint: stateEvidenceFingerprint(candidateHash, {
        gates,
        provenance: candidateProvenance,
        sourceMainContentTreeHash: baseHash,
      }),
    },
    gates,
  };
  writeFileSync(
    join(
      candidateRoot,
      ".claude",
      "axis-redesign",
      "GENERATED_STATE.json",
    ),
    JSON.stringify(candidateSnapshot),
  );
  git(candidateRoot, "add", ".");
  git(candidateRoot, "commit", "-m", "state refresh");
}

describe("committed release migration manifest", () => {
  it("matches every committed migration, including the count and latest entry", () => {
    const manifest = committedManifest();
    const migrations = actualMigrations();

    expect(validateMigrationManifest(manifest, migrations)).toEqual([]);
    expect(manifest.migrationCount).toBe(migrations.length);
    expect(manifest.latest).toEqual(migrations.at(-1));
  });

  it("detects a removed tracked migration", () => {
    const migrations = actualMigrations();
    const removed = migrations[0];
    const errors = validateMigrationManifest(committedManifest(), migrations.slice(1));

    expect(errors).toContain(`missing tracked migration ${removed.file}`);
  });

  it("detects changed migration contents through the digest", () => {
    const migrations = actualMigrations();
    const changed = { ...migrations[0], sha256: "0".repeat(64) };
    const errors = validateMigrationManifest(committedManifest(), [
      changed,
      ...migrations.slice(1),
    ]);

    expect(errors).toContain(`changed tracked migration ${changed.file}`);
  });

  it("detects an untracked migration file", () => {
    const migrations = actualMigrations();
    const extra = {
      version: "99999999999999",
      file: "supabase/migrations/99999999999999_adversarial_extra.sql",
      sha256: "f".repeat(64),
    };
    const errors = validateMigrationManifest(committedManifest(), [...migrations, extra]);

    expect(errors).toContain(`untracked migration ${extra.file}`);
  });

  it("detects a reordered manifest even when its entries and digests still exist", () => {
    const manifest = committedManifest();
    [manifest.migrations[0], manifest.migrations[1]] = [
      manifest.migrations[1],
      manifest.migrations[0],
    ];
    const errors = validateMigrationManifest(manifest, actualMigrations());

    expect(errors).toContain("migration manifest entries are not in lexical filename order");
  });

  it("rejects two manifest files claiming the same numeric migration version", () => {
    const manifest = committedManifest();
    manifest.migrations[1].version = manifest.migrations[0].version;
    const errors = validateMigrationManifest(manifest, actualMigrations());

    expect(errors).toContain("migration manifest contains duplicate numeric versions");
  });

  it("rejects two scanned migration files claiming the same numeric version", () => {
    const migrations = actualMigrations();
    const duplicateVersion = {
      ...migrations[1],
      version: migrations[0].version,
    };
    const errors = validateMigrationManifest(committedManifest(), [
      migrations[0],
      duplicateVersion,
      ...migrations.slice(2),
    ]);

    expect(errors).toContain("migration tree contains duplicate numeric versions");
  });

  it("rejects a scanned migration tree that is not in lexical filename order", () => {
    const migrations = actualMigrations();
    [migrations[0], migrations[1]] = [migrations[1], migrations[0]];
    const errors = validateMigrationManifest(committedManifest(), migrations);

    expect(errors).toContain("migration tree entries are not in lexical filename order");
  });

  it("rejects a rewritten protected migration even when the proposed manifest matches its changed tree", () => {
    const baseline = protectedLedgerFixture();
    const rewrittenEntries = structuredClone(baseline.migrations);
    rewrittenEntries[0].sha256 = "d".repeat(64);
    const proposed = synchronizedManifest(rewrittenEntries);

    expect(validateMigrationManifest(proposed, rewrittenEntries)).toEqual([]);
    expect(validateAppendOnlyMigrationManifest(baseline, proposed)).toContain(
      `rewritten protected migration ${baseline.migrations[0].file}`,
    );
  });

  it("rejects a deleted protected migration even when the proposed manifest matches its shortened tree", () => {
    const baseline = protectedLedgerFixture();
    const shortenedEntries = structuredClone(baseline.migrations.slice(1));
    const proposed = synchronizedManifest(shortenedEntries);

    expect(validateMigrationManifest(proposed, shortenedEntries)).toEqual([]);
    expect(validateAppendOnlyMigrationManifest(baseline, proposed)).toContain(
      `deleted protected migration ${baseline.migrations[0].file}`,
    );
  });

  it("rejects a renamed protected migration even when its digest and proposed manifest match", () => {
    const baseline = protectedLedgerFixture();
    const renamedEntries = structuredClone(baseline.migrations);
    renamedEntries[0].file = "supabase/migrations/20260701000000_renamed_alpha.sql";
    const proposed = synchronizedManifest(renamedEntries);

    expect(validateMigrationManifest(proposed, renamedEntries)).toEqual([]);
    expect(validateAppendOnlyMigrationManifest(baseline, proposed)).toContain(
      `renamed protected migration ${baseline.migrations[0].file} to ${renamedEntries[0].file}`,
    );
  });

  it("rejects reordered protected ledger entries", () => {
    const baseline = protectedLedgerFixture();
    const reorderedEntries = structuredClone(baseline.migrations);
    [reorderedEntries[1], reorderedEntries[2]] = [
      reorderedEntries[2],
      reorderedEntries[1],
    ];
    const proposed = synchronizedManifest(reorderedEntries);

    expect(validateAppendOnlyMigrationManifest(baseline, proposed)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reordered protected migration"),
      ]),
    );
  });

  it("rejects a lexically valid migration inserted before the protected ledger tail", () => {
    const baseline = protectedLedgerFixture();
    const inserted = {
      version: "20260702500000",
      file: "supabase/migrations/20260702500000_non_tail_insertion.sql",
      sha256: "b".repeat(64),
    };
    const entries = structuredClone(baseline.migrations) as MigrationEntry[];
    const index = entries.findIndex((entry) => entry.file > inserted.file);
    entries.splice(index, 0, inserted);
    const proposed = synchronizedManifest(entries);

    expect(validateMigrationManifest(proposed, entries)).toEqual([]);
    expect(validateAppendOnlyMigrationManifest(baseline, proposed)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reordered protected migration"),
        expect.stringContaining("not a strict lexical append"),
      ]),
    );
  });
});

describe("migration directory contract", () => {
  it("fails closed on an uppercase SQL extension", () => {
    withMigrationFixture((fixture) => {
      writeFileSync(join(fixture, "20260722000001_uppercase.SQL"), "select 1;\n");

      expect(() => collectMigrationEntries(fixture)).toThrow(
        /unexpected migration file 20260722000001_uppercase\.SQL/,
      );
    });
  });

  it("fails closed on a non-SQL metadata or stray file", () => {
    withMigrationFixture((fixture) => {
      writeFileSync(join(fixture, "README.md"), "not a migration\n");

      expect(() => collectMigrationEntries(fixture)).toThrow(
        /unexpected migration file README\.md/,
      );
    });
  });

  it("fails closed on a nested directory", () => {
    withMigrationFixture((fixture) => {
      mkdirSync(join(fixture, "archive"));

      expect(() => collectMigrationEntries(fixture)).toThrow(
        /unexpected migration directory entry archive/,
      );
    });
  });
});

describe("protected baseline provenance", () => {
  it("uses the immutable pull-request base SHA from the GitHub event payload", () => {
    withGitHistory(({ root: fixture, base }) => {
      const eventPath = join(fixture, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { base: { sha: base } } }),
      );

      expect(
        resolveProtectedBaselineRevision(fixture, {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
        }),
      ).toEqual({
        revision: base,
        source: "github-event:pull_request:pull_request.base.sha",
      });
    });
  });

  it("uses push.before and rejects a caller-controlled GitHub override", () => {
    withGitHistory(({ root: fixture, base }) => {
      const eventPath = join(fixture, "event.json");
      writeFileSync(eventPath, JSON.stringify({ before: base }));
      expect(
        resolveProtectedBaselineRevision(fixture, {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_PATH: eventPath,
        }).revision,
      ).toBe(base);
      expect(() =>
        resolveProtectedBaselineRevision(fixture, {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_PATH: eventPath,
          AXIS_RELEASE_BASE_REF: "HEAD",
        }),
      ).toThrow(/AXIS_RELEASE_BASE_REF is forbidden in GitHub Actions/);
    });
  });

  it("rejects offline HEAD self-selection and non-ancestor overrides", () => {
    withGitHistory(({ root: fixture, base, head }) => {
      expect(() =>
        resolveProtectedBaselineRevision(fixture, {
          AXIS_RELEASE_BASE_REF: "HEAD",
        }),
      ).toThrow(/selects HEAD\/current tree/);

      git(fixture, "checkout", "--orphan", "unrelated");
      writeFileSync(join(fixture, "unrelated.txt"), "unrelated\n");
      git(fixture, "add", "unrelated.txt");
      git(fixture, "commit", "-m", "unrelated");
      const unrelated = git(fixture, "rev-parse", "HEAD");
      git(fixture, "checkout", head);
      expect(() =>
        resolveProtectedBaselineRevision(fixture, {
          AXIS_RELEASE_BASE_REF: unrelated,
        }),
      ).toThrow(/is not an ancestor of HEAD/);
      expect(
        resolveProtectedBaselineRevision(fixture, {
          AXIS_RELEASE_BASE_REF: base,
        }).revision,
      ).toBe(base);
    });
  });
});

describe("Vercel production deployment ownership", () => {
  it("keeps Vercel Git integration as the repository's sole production deploy owner", () => {
    expect(findSecondaryVercelProductionDeploys(join(root, ".github", "workflows"))).toEqual([]);
  });

  it("rejects a workflow that tries to run a Vercel production deploy", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-release-owner-"));
    try {
      writeFileSync(
        join(fixture, "environment-read.yml"),
        "jobs:\n  configure:\n    steps:\n      - run: npx vercel env pull --prod\n",
      );
      writeFileSync(
        join(fixture, "second-owner.yml"),
        "jobs:\n  deploy:\n    steps:\n      - run: npx vercel deploy --token $VERCEL_TOKEN --prod\n",
      );

      expect(findSecondaryVercelProductionDeploys(fixture)).toEqual(["second-owner.yml"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects multiline commands, package-script indirection, and Vercel deployment actions", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-release-owner-"));
    try {
      writeFileSync(
        join(fixture, "multiline.yml"),
        "jobs:\n  deploy:\n    steps:\n      - run: |\n          npx vercel deploy \\\n            --prod --token $VERCEL_TOKEN\n",
      );
      writeFileSync(
        join(fixture, "folded-multiline.yml"),
        "jobs:\n  deploy:\n    steps:\n      - run: >-\n          npx vercel deploy\n          --prod --token $VERCEL_TOKEN\n",
      );
      writeFileSync(
        join(fixture, "script.yml"),
        "jobs:\n  deploy:\n    steps:\n      - run: npm run production-release\n",
      );
      writeFileSync(
        join(fixture, "argument-script.yml"),
        "jobs:\n  deploy:\n    steps:\n      - run: npm run argument-release -- --prod\n",
      );
      writeFileSync(
        join(fixture, "action.yml"),
        "jobs:\n  deploy:\n    steps:\n      - uses: amondnet/vercel-action@0123456789012345678901234567890123456789\n",
      );

      expect(
        findSecondaryVercelProductionDeploys(fixture, {
          packageScripts: {
            "production-release": "npm run vercel-prod",
            "vercel-prod": "npx vercel deploy --prod",
            "argument-release": "npx vercel deploy",
          },
        }),
      ).toEqual([
        "action.yml",
        "argument-script.yml",
        "folded-multiline.yml",
        "multiline.yml",
        "script.yml",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("does not mistake a production environment pull for a deployment", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-release-owner-"));
    try {
      writeFileSync(
        join(fixture, "environment-read.yml"),
        "jobs:\n  configure:\n    steps:\n      - run: >-\n          npx vercel env pull --prod\n",
      );

      expect(findSecondaryVercelProductionDeploys(fixture)).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("parses flow mappings and rejects the CLI's default production deploy form", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-release-owner-"));
    try {
      writeFileSync(
        join(fixture, "flow.yml"),
        'jobs: { deploy: { steps: [ { run: "npx vercel --prod" } ] } }\n',
      );
      writeFileSync(
        join(fixture, "script.yml"),
        'jobs: { deploy: { steps: [ { run: "npm run ship -- --prod" } ] } }\n',
      );
      writeFileSync(
        join(fixture, "script-flags.yml"),
        'jobs: { deploy: { steps: [ { run: "npm --silent run --if-present ship -- --prod" } ] } }\n',
      );

      expect(
        findSecondaryVercelProductionDeploys(fixture, {
          packageScripts: { ship: "npx vercel" },
        }),
      ).toEqual(["flow.yml", "script-flags.yml", "script.yml"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("GitHub Action provenance", () => {
  it("pins every repository workflow action to an immutable full commit SHA", () => {
    expect(findMutableGitHubActionReferences(join(root, ".github", "workflows"))).toEqual([]);
  });

  it("rejects mutable action tags and branch references", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-action-pins-"));
    try {
      writeFileSync(
        join(fixture, "mutable.yml"),
        "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: vendor/action@main\n",
      );

      expect(findMutableGitHubActionReferences(fixture)).toEqual([
        "mutable.yml:jobs.build.steps[0].uses: actions/checkout@v4",
        "mutable.yml:jobs.build.steps[1].uses: vendor/action@main",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("parses flow-style uses and requires a readable version comment", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-action-pins-"));
    try {
      const sha = "1".repeat(40);
      writeFileSync(
        join(fixture, "flow.yml"),
        `jobs: { build: { steps: [ { uses: vendor/action@${sha} } ] } }\n`,
      );
      expect(findMutableGitHubActionReferences(fixture)).toEqual([
        expect.stringContaining("is missing a readable # vX.Y.Z comment"),
      ]);

      writeFileSync(
        join(fixture, "flow.yml"),
        `jobs: { build: { steps: [ { uses: vendor/action@${sha} } ] } } # v1.2.3\n`,
      );
      expect(findMutableGitHubActionReferences(fixture)).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("does not accept a readable-version decoy in a YAML comment", () => {
    const fixture = mkdtempSync(join(tmpdir(), "axis-action-pins-"));
    try {
      const sha = "2".repeat(40);
      writeFileSync(
        join(fixture, "comment-decoy.yml"),
        `# uses: vendor/action@${sha} # v1.2.3\njobs:\n  build:\n    steps:\n      - uses: vendor/action@${sha}\n`,
      );
      expect(findMutableGitHubActionReferences(fixture)).toEqual([
        expect.stringContaining("is missing a readable # vX.Y.Z comment"),
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("trusted pull-request release governance", () => {
  it("keeps the committed pull_request_target workflow closed to candidate execution", () => {
    const content = readFileSync(
      join(root, ".github", "workflows", "release-governance.yml"),
      "utf8",
    );
    expect(validateReleaseGovernanceWorkflow(content)).toEqual([]);
  });

  it("rejects extra candidate execution even when appended to an otherwise trusted workflow", () => {
    const content = readFileSync(
      join(root, ".github", "workflows", "release-governance.yml"),
      "utf8",
    ).replace(
      "      - name: Validate candidate with trusted base code",
      "      - name: Execute candidate package\n        run: npm test\n        working-directory: candidate\n\n      - name: Validate candidate with trusted base code",
    );
    expect(validateReleaseGovernanceWorkflow(content)).toContain(
      "release-governance job must contain exactly five trusted steps",
    );
  });

  it("validates an untrusted candidate as data against an independent base tree", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual([]);
    });
  });

  it("catches a candidate migration rewrite even when its own manifest matches", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      const changed = "select 2;\n";
      const file = "supabase/migrations/20260701000000_alpha.sql";
      writeFileSync(join(candidateRoot, file), changed);
      const entry = {
        version: "20260701000000",
        file,
        sha256: checksum(changed),
      };
      writeFileSync(
        join(candidateRoot, "scripts", "release-migration-manifest.json"),
        JSON.stringify(synchronizedManifest([entry])),
      );

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toContain(`rewritten protected migration ${file}`);
    });
  });

  it("rejects changes to the base-controlled validator and workflow directory", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      writeFileSync(
        join(candidateRoot, "scripts", "derive-program-state.mjs"),
        "// candidate bypass\n",
      );
      writeFileSync(
        join(candidateRoot, ".github", "workflows", "shadow.yml"),
        "name: shadow\non: pull_request\njobs: {}\n",
      );

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "trusted control-plane file scripts/derive-program-state.mjs differs",
          ),
          expect.stringContaining(
            "candidate .github/workflows directory differs byte-for-byte",
          ),
        ]),
      );
    });
  });

  it("freezes the complete critical gate toolchain and protected-base tests", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      const changedControlFiles = [
        "tsconfig.json",
        "vitest.config.ts",
        "postcss.config.mjs",
        "tailwind.config.ts",
        "package-lock.json",
        ".claude/axis-redesign/PERFORMANCE_BUDGETS.json",
        "scripts/check-bundle-budget.mjs",
      ];
      for (const file of changedControlFiles) {
        writeFileSync(
          join(candidateRoot, file),
          `${readFileSync(join(candidateRoot, file), "utf8")}\n`,
        );
      }
      writeFileSync(
        join(candidateRoot, "src", "protected-gate.test.ts"),
        "export const protectedGateFixture = false;\n",
      );
      writeFileSync(
        join(candidateRoot, "tests", "e2e", "candidate-bypass.spec.ts"),
        "export const bypass = true;\n",
      );

      const errors = validateCandidateReleaseGovernance({
        baseRoot,
        candidateRoot,
      });
      for (const file of changedControlFiles) {
        expect(errors).toContain(
          `trusted control-plane file ${file} differs from the protected base; use the documented owner break-glass procedure`,
        );
      }
      expect(errors).toContain(
        "candidate protected-base test src/protected-gate.test.ts differs byte-for-byte from the protected base; use the documented owner break-glass procedure or add a new test file",
      );
    });
  });

  it("allows additive tests while retaining every protected file and digest", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      writeFileSync(
        join(candidateRoot, "tests", "e2e", "candidate-addition.spec.ts"),
        "export const candidateAddition = true;\n",
      );
      writeSynchronizedGeneratedState(baseRoot, candidateRoot);

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual([]);
    });
  });

  it("rejects deleted protected test paths and lower measured test totals", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      rmSync(join(candidateRoot, "src", "protected-gate.test.ts"));
      writeSynchronizedGeneratedState(baseRoot, candidateRoot);
      const snapshotPath = join(
        candidateRoot,
        ".claude",
        "axis-redesign",
        "GENERATED_STATE.json",
      );
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      snapshot.gates.tests = { passed: 0, total: 0, files: 0, suites: 0 };
      writeFileSync(snapshotPath, JSON.stringify(snapshot));

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual(
        expect.arrayContaining([
          "candidate removed or renamed protected-base test src/protected-gate.test.ts; test additions are allowed but protected paths must remain",
          expect.stringContaining(
            "candidate measured test total 0 is below protected-base total 1",
          ),
          expect.stringContaining(
            "candidate measured test files 0 is below protected-base files 1",
          ),
          expect.stringContaining(
            "candidate measured test suites 0 is below protected-base suites 1",
          ),
        ]),
      );
    });
  });

  it("rejects alternate candidate config and package-manager override files", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      for (const file of FORBIDDEN_GATE_OVERRIDE_PATHS) {
        writeFileSync(
          join(candidateRoot, file),
          file === ".postcssrc.js"
            ? "module.exports = { plugins: { 'candidate-postcss-plugin': {} } };\n"
            : file === "tailwind.config.mjs"
              ? "export default { plugins: ['candidate-tailwind-plugin'] };\n"
              : "{}\n",
        );
      }

      const errors = validateCandidateReleaseGovernance({
        baseRoot,
        candidateRoot,
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          ...FORBIDDEN_GATE_OVERRIDE_PATHS.map(
            (file) =>
              `candidate alternate gate/toolchain override ${file} is forbidden; use the documented owner break-glass procedure`,
          ),
        ]),
      );
    });
  });

  it("rejects package-script indirection and removal of the production ignore gate", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      writeFileSync(
        join(candidateRoot, "package.json"),
        JSON.stringify({ scripts: { test: "echo green" } }),
      );
      writeFileSync(
        join(candidateRoot, "vercel.json"),
        JSON.stringify({ ignoreCommand: "exit 1" }),
      );

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "candidate package scripts differ from the protected base",
          ),
          expect.stringContaining("vercel.json ignoreCommand must remain exactly"),
        ]),
      );
    });
  });

  it("rejects Vercel execution-control changes even when ignoreCommand remains exact", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      const vercelPath = join(candidateRoot, "vercel.json");
      const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
      vercel.build = {
        env: {
          NODE_OPTIONS: "--import=./candidate-startup-hook.mjs",
        },
      };
      writeFileSync(vercelPath, JSON.stringify(vercel));

      const errors = validateCandidateReleaseGovernance({
        baseRoot,
        candidateRoot,
      });
      expect(errors).toContain(
        "trusted control-plane file vercel.json differs from the protected base; use the documented owner break-glass procedure",
      );
      expect(errors).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("vercel.json ignoreCommand must remain exactly"),
        ]),
      );
    });
  });

  it("pins the YAML parser specifier and lockfile resolution used by trusted base code", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      const packagePath = join(candidateRoot, "package.json");
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      packageJson.devDependencies["js-yaml"] = "latest";
      writeFileSync(packagePath, JSON.stringify(packageJson));

      const lockPath = join(candidateRoot, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.packages["node_modules/js-yaml"].integrity = "sha512-attacker";
      writeFileSync(lockPath, JSON.stringify(lock));

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toContain(
        "trusted js-yaml parser contract must remain pinned to the reviewed 4.3.0 specifier, resolution URL, and integrity",
      );
    });
  });

  it("rejects a forged source-main alignment claim for changed candidate source", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      writeFileSync(join(candidateRoot, "new-source.txt"), "changed source\n");
      git(candidateRoot, "add", ".");
      git(candidateRoot, "commit", "-m", "changed source");
      const candidateHash = gitTreeContentHash({
        cwd: candidateRoot,
        ref: "HEAD",
      });
      const gates = {
        measured: true,
        sourceContentTreeHash: candidateHash,
      };
      const provenance = {
        branch: "candidate",
        head: "candidate",
        mainHead: "candidate",
        workingTreeClean: true,
        aheadOfMain: [],
      };
      writeFileSync(
        join(
          candidateRoot,
          ".claude",
          "axis-redesign",
          "GENERATED_STATE.json",
        ),
        JSON.stringify({
          git: {
            ...provenance,
            contentTreeHash: candidateHash,
            sourceMainContentTreeHash: candidateHash,
            fingerprint: stateEvidenceFingerprint(candidateHash, {
              gates,
              provenance,
              sourceMainContentTreeHash: candidateHash,
            }),
          },
          gates,
        }),
      );
      git(candidateRoot, "add", ".");
      git(candidateRoot, "commit", "-m", "forged aligned state");

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toContain(
        "candidate GENERATED_STATE sourceMainContentTreeHash does not match the independently checked-out protected base",
      );
    });
  });

  it("rejects fabricated gate evidence in a source-identical state refresh", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      const snapshotPath = join(
        candidateRoot,
        ".claude",
        "axis-redesign",
        "GENERATED_STATE.json",
      );
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      snapshot.gates = {
        measured: true,
        sourceContentTreeHash: snapshot.git.contentTreeHash,
        tests: { passed: 999999, total: 999999 },
      };
      const provenance = {
        branch: snapshot.git.branch,
        head: snapshot.git.head,
        mainHead: snapshot.git.mainHead,
        workingTreeClean: snapshot.git.workingTreeClean,
        aheadOfMain: snapshot.git.aheadOfMain,
      };
      snapshot.git.fingerprint = stateEvidenceFingerprint(
        snapshot.git.contentTreeHash,
        {
          gates: snapshot.gates,
          provenance,
          sourceMainContentTreeHash: snapshot.git.sourceMainContentTreeHash,
        },
      );
      writeFileSync(snapshotPath, JSON.stringify(snapshot));

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toContain(
        "state-refresh candidate changed gate evidence even though source content is unchanged; preserve the protected measured evidence",
      );
    });
  });

  it("permits the control-plane bootstrap only when every bootstrap file is absent from base", () => {
    expect(TRUSTED_CONTROL_BOOTSTRAP_FILES).toEqual([
      ".github/workflows/release-governance.yml",
      "scripts/validate-release-candidate.mjs",
      "scripts/release-validation-core.mjs",
      "scripts/vercel-ignore-build.sh",
      "scripts/vercel-ignore-build.mjs",
      "scripts/state-tree-integrity.mjs",
    ]);

    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      for (const file of TRUSTED_CONTROL_BOOTSTRAP_FILES) {
        rmSync(join(baseRoot, file));
      }
      git(baseRoot, "add", ".");
      git(baseRoot, "commit", "-m", "pre-bootstrap protected base");
      writeSynchronizedGeneratedState(baseRoot, candidateRoot);

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual([]);
    });
  });

  it("fails closed when the protected base has only part of the trusted control plane", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      rmSync(join(baseRoot, "scripts", "vercel-ignore-build.sh"));
      git(baseRoot, "add", ".");
      git(baseRoot, "commit", "-m", "incomplete protected base");
      writeSynchronizedGeneratedState(baseRoot, candidateRoot);

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toContain(
        "protected base has an incomplete release control plane; owner break-glass recovery is required",
      );
    });
  });

  it("rejects symlinked candidate control-plane parents without following them", () => {
    withCandidateTrees(({ baseRoot, candidateRoot }) => {
      rmSync(join(candidateRoot, ".github"), { recursive: true });
      symlinkSync(join(baseRoot, ".github"), join(candidateRoot, ".github"), "dir");

      expect(
        validateCandidateReleaseGovernance({ baseRoot, candidateRoot }),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "trusted control-plane file .github/workflows/release-governance.yml must remain a regular file",
          ),
        ]),
      );
    });
  });
});
