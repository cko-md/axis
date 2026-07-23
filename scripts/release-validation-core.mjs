import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  gitTreeContentHash,
  stateEvidenceFingerprint,
} from "./state-tree-integrity.mjs";

const MIGRATION_FILE = /^(\d+)_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const MIGRATION_FILE_CONTRACT =
  "<numeric-version>_<lowercase-snake-case-name>.sql";
export const TRUSTED_CONTROL_BOOTSTRAP_FILES = [
  ".github/workflows/release-governance.yml",
  "scripts/validate-release-candidate.mjs",
  "scripts/release-validation-core.mjs",
  "scripts/vercel-ignore-build.sh",
  "scripts/vercel-ignore-build.mjs",
  "scripts/state-tree-integrity.mjs",
];
export const TRUSTED_CONTROL_PLANE_FILES = [
  ...TRUSTED_CONTROL_BOOTSTRAP_FILES,
  "scripts/derive-program-state.mjs",
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "eslint.config.mjs",
  "vitest.config.ts",
  "vitest.setup.ts",
  "playwright.config.ts",
  "playwright.electron.config.ts",
  "next.config.ts",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "vercel.json",
  ".claude/axis-redesign/PERFORMANCE_BUDGETS.json",
  "scripts/check-bundle-budget.mjs",
  "scripts/bundle-partition-core.mjs",
  "scripts/check-perf-budgets.mjs",
  "scripts/build-vector-offline-bootstrap.mjs",
  "scripts/generate-vector-offline-manifests.mjs",
  "scripts/bootstrap-authenticated-e2e.mjs",
  "scripts/authenticated-e2e-credentials.mjs",
  "scripts/validate-release-wave.mjs",
  "supabase/config.toml",
  "scripts/sql/bootstrap-local-e2e-role-grants.sql",
  "scripts/sql/verify-20260716-contract.sql",
];
const REQUIRED_VERCEL_IGNORE_COMMAND =
  "sh -c 'sh scripts/vercel-ignore-build.sh; status=$?; if [ \"$status\" -eq 74 ]; then exit 1; fi; exit 0'";
const TRUSTED_YAML_PARSER = {
  specifier: "4.3.0",
  version: "4.3.0",
  resolved: "https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.0.tgz",
  integrity:
    "sha512-1td788aAnnZ5qs7V2QIRl1owjtYpbKt749Y3xauqQgwIIGF/xXWz1wMTEBx5O3LK3lXLVuqXPdPxj2BoFHaW9Q==",
};
const LOCAL_GATE_CONTRACT =
  "exact committed source: typecheck, lint, full unit suite, clean Next production build, aggregate bundle budget";
const TRUSTED_TEST_SURFACES = [
  {
    root: "src",
    recursive: true,
    include: (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
  },
  {
    root: "tests",
    recursive: true,
    include: () => true,
  },
  {
    root: "electron",
    recursive: false,
    include: (file) => /\.test\.cjs$/.test(file),
  },
];
export const FORBIDDEN_GATE_OVERRIDE_PATHS = [
  ".eslintignore",
  ".node-version",
  ".npmrc",
  ".postcssrc",
  ".postcssrc.cjs",
  ".postcssrc.cts",
  ".postcssrc.js",
  ".postcssrc.json",
  ".postcssrc.mjs",
  ".postcssrc.mts",
  ".postcssrc.ts",
  ".postcssrc.yaml",
  ".postcssrc.yml",
  "npm-shrinkwrap.json",
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.cts",
  "eslint.config.mts",
  "eslint.config.ts",
  "next.config.js",
  "next.config.mjs",
  "postcss.config.cjs",
  "postcss.config.cts",
  "postcss.config.js",
  "postcss.config.json",
  "postcss.config.mts",
  "postcss.config.ts",
  "playwright.config.cjs",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.mts",
  "tailwind.config.cjs",
  "tailwind.config.cts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.mts",
  "vitest.config.cjs",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.mts",
];

export function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function collectMigrationEntries(migrationDirectory) {
  if (!existsSync(migrationDirectory)) {
    throw new Error(`missing migration directory ${migrationDirectory}`);
  }

  return readdirSync(migrationDirectory, { withFileTypes: true })
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `unexpected migration directory entry ${entry.name}; only regular migration files are allowed`,
        );
      }

      const match = entry.name.match(MIGRATION_FILE);
      if (!match) {
        throw new Error(
          `unexpected migration file ${entry.name}; expected ${MIGRATION_FILE_CONTRACT}`,
        );
      }

      return {
        version: match[1],
        file: `supabase/migrations/${entry.name}`,
        sha256: checksum(readFileSync(join(migrationDirectory, entry.name))),
      };
    });
}

export function readMigrationManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read migration manifest ${manifestPath}: ${detail}`);
  }
}

function parseMigrationFilename(file) {
  const filename = file.split("/").at(-1) ?? "";
  const match = filename.match(MIGRATION_FILE);
  if (!match) {
    throw new Error(
      `unexpected migration file ${file}; expected ${MIGRATION_FILE_CONTRACT}`,
    );
  }
  return { version: match[1], file };
}

function isManifestEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.version === "string" &&
    typeof value.file === "string" &&
    typeof value.sha256 === "string"
  );
}

function entryLabel(entry) {
  return isManifestEntry(entry) ? entry.file : "<invalid manifest entry>";
}

function sameEntry(left, right) {
  return (
    isManifestEntry(left) &&
    isManifestEntry(right) &&
    left.version === right.version &&
    left.file === right.file &&
    left.sha256 === right.sha256
  );
}

/**
 * Verify that a committed manifest is an exact, ordered ledger of the migration
 * tree. The caller owns presentation so this pure function can be fault-tested
 * without touching the repository's migrations.
 */
export function validateMigrationManifest(manifest, actualMigrations) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return ["migration manifest must be a JSON object"];
  }
  if (manifest.schemaVersion !== 1) {
    errors.push("migration manifest schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.migrations)) {
    errors.push("migration manifest migrations must be an array");
    return errors;
  }
  if (!Array.isArray(actualMigrations)) {
    errors.push("actual migrations must be an array");
    return errors;
  }

  const entries = manifest.migrations;
  for (const entry of entries) {
    if (!isManifestEntry(entry)) {
      errors.push("migration manifest contains an invalid entry");
      continue;
    }
    const filename = entry.file.split("/").at(-1) ?? "";
    const match = filename.match(MIGRATION_FILE);
    if (!match || entry.version !== match[1]) {
      errors.push(`${entry.file} does not match declared version ${entry.version}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      errors.push(`${entry.file} has an invalid SHA-256 digest`);
    }
  }

  const manifestFiles = entries.map(entryLabel);
  const sortedManifestFiles = [...manifestFiles].sort();
  if (manifestFiles.join("\n") !== sortedManifestFiles.join("\n")) {
    errors.push("migration manifest entries are not in lexical filename order");
  }
  if (new Set(manifestFiles).size !== manifestFiles.length) {
    errors.push("migration manifest contains duplicate filenames");
  }
  const manifestVersions = entries
    .filter(isManifestEntry)
    .map((entry) => entry.version);
  if (new Set(manifestVersions).size !== manifestVersions.length) {
    errors.push("migration manifest contains duplicate numeric versions");
  }

  const actualFiles = actualMigrations.map((entry) => entry.file);
  if (actualFiles.join("\n") !== [...actualFiles].sort().join("\n")) {
    errors.push("migration tree entries are not in lexical filename order");
  }
  const actualVersions = actualMigrations.map((entry) => entry.version);
  if (new Set(actualVersions).size !== actualVersions.length) {
    errors.push("migration tree contains duplicate numeric versions");
  }

  if (manifest.migrationCount !== entries.length) {
    errors.push(
      `migration manifest count ${manifest.migrationCount} does not match ${entries.length} entries`,
    );
  }
  if (actualMigrations.length !== entries.length) {
    errors.push(
      `migration tree count ${actualMigrations.length} does not match manifest count ${entries.length}`,
    );
  }

  const expectedLatest = entries.at(-1);
  if (!isManifestEntry(expectedLatest) || !sameEntry(manifest.latest, expectedLatest)) {
    errors.push("migration manifest latest does not match its final ordered entry");
  }
  const actualLatest = actualMigrations.at(-1);
  if (!expectedLatest || !actualLatest || !sameEntry(expectedLatest, actualLatest)) {
    errors.push("migration tree latest does not match manifest latest");
  }

  const actualByFile = new Map(actualMigrations.map((entry) => [entry.file, entry]));
  const expectedByFile = new Map(entries.filter(isManifestEntry).map((entry) => [entry.file, entry]));

  for (const expected of entries.filter(isManifestEntry)) {
    const actual = actualByFile.get(expected.file);
    if (!actual) {
      errors.push(`missing tracked migration ${expected.file}`);
    } else if (!sameEntry(expected, actual)) {
      errors.push(`changed tracked migration ${expected.file}`);
    }
  }
  for (const actual of actualMigrations) {
    if (!expectedByFile.has(actual.file)) {
      errors.push(`untracked migration ${actual.file}`);
    }
  }

  return errors;
}

/**
 * A release manifest is a ledger, not an editable snapshot. Compare it to the
 * protected merge base so a PR cannot hide a historical migration rewrite by
 * changing its working manifest in the same commit. Only strict lexical tail
 * additions are permitted.
 */
export function validateAppendOnlyMigrationManifest(baseline, proposed) {
  const errors = [];
  const baselineEntries = baseline?.migrations;
  const proposedEntries = proposed?.migrations;

  if (!Array.isArray(baselineEntries)) {
    return ["protected migration baseline migrations must be an array"];
  }
  if (!Array.isArray(proposedEntries)) {
    return ["proposed migration manifest migrations must be an array"];
  }

  for (const entry of baselineEntries) {
    if (!isManifestEntry(entry)) {
      errors.push("protected migration baseline contains an invalid entry");
    }
  }
  for (const entry of proposedEntries) {
    if (!isManifestEntry(entry)) {
      errors.push("proposed migration manifest contains an invalid entry");
    }
  }
  if (errors.length > 0) return errors;

  const proposedByFile = new Map(proposedEntries.map((entry) => [entry.file, entry]));
  const proposedIndexByFile = new Map(
    proposedEntries.map((entry, index) => [entry.file, index]),
  );

  for (let index = 0; index < baselineEntries.length; index += 1) {
    const expected = baselineEntries[index];
    const received = proposedEntries[index];
    if (sameEntry(expected, received)) continue;

    const matchingFile = proposedByFile.get(expected.file);
    if (!matchingFile) {
      const renamed = proposedEntries.find(
        (entry) =>
          entry.version === expected.version && entry.sha256 === expected.sha256,
      );
      if (renamed) {
        errors.push(
          `renamed protected migration ${expected.file} to ${renamed.file}`,
        );
      } else {
        errors.push(`deleted protected migration ${expected.file}`);
      }
      continue;
    }
    if (!sameEntry(expected, matchingFile)) {
      errors.push(`rewritten protected migration ${expected.file}`);
      continue;
    }
    errors.push(
      `reordered protected migration ${expected.file} from index ${index} to ${proposedIndexByFile.get(expected.file)}`,
    );
  }

  if (proposedEntries.length < baselineEntries.length) {
    errors.push("proposed migration manifest truncates the protected ledger");
  }

  const baselineByFile = new Map(baselineEntries.map((entry) => [entry.file, entry]));
  const tail = baselineEntries.at(-1);
  for (const entry of proposedEntries) {
    if (baselineByFile.has(entry.file)) continue;
    if (tail && entry.file <= tail.file) {
      errors.push(
        `migration ${entry.file} is not a strict lexical append after protected tail ${tail.file}`,
      );
    }
  }

  return errors;
}

function runGit(root, args, encoding = "utf8") {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot resolve protected migration baseline: git ${args.join(" ")}: ${detail}`);
  }
}

function gitRefExists(root, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isGitHubActions(environment) {
  return environment.GITHUB_ACTIONS === "true";
}

function assertReviewedAncestor(
  root,
  revision,
  source,
  { allowProtectedHeadForDirtyWorktree = false } = {},
) {
  const head = runGit(root, ["rev-parse", "HEAD^{commit}"]);
  const resolved = runGit(root, ["rev-parse", `${revision}^{commit}`]);
  if (resolved === head) {
    if (
      allowProtectedHeadForDirtyWorktree &&
      runGit(root, ["status", "--porcelain", "--untracked-files=all"])
    ) {
      // The remote-protected commit is the reviewed base; the uncommitted
      // working tree is the distinct candidate. This is not allowed for a
      // caller-selected override or a clean current tree.
      return resolved;
    }
    throw new Error(
      `cannot resolve protected migration baseline: ${source} selects HEAD/current tree instead of a reviewed ancestor`,
    );
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", resolved, head], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `cannot resolve protected migration baseline: ${source} (${resolved}) is not an ancestor of HEAD`,
    );
  }
  return resolved;
}

function readGitHubBaseline(environment) {
  if (environment.AXIS_RELEASE_BASE_REF?.trim()) {
    throw new Error(
      "cannot resolve protected migration baseline: AXIS_RELEASE_BASE_REF is forbidden in GitHub Actions; the immutable event payload owns the baseline",
    );
  }
  const eventPath = environment.GITHUB_EVENT_PATH?.trim();
  const eventName = environment.GITHUB_EVENT_NAME?.trim();
  if (!eventPath || !eventName) {
    throw new Error(
      "cannot resolve protected migration baseline: GitHub Actions requires GITHUB_EVENT_PATH and GITHUB_EVENT_NAME",
    );
  }

  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot resolve protected migration baseline: invalid GitHub event payload: ${detail}`,
    );
  }

  let revision;
  let source;
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    revision = event?.pull_request?.base?.sha;
    source = `github-event:${eventName}:pull_request.base.sha`;
  } else if (eventName === "push") {
    revision = event?.before;
    source = "github-event:push:before";
  } else {
    throw new Error(
      `cannot resolve protected migration baseline: unsupported GitHub event ${eventName}`,
    );
  }

  if (
    typeof revision !== "string" ||
    !/^[a-f0-9]{40}$/i.test(revision) ||
    /^0{40}$/.test(revision)
  ) {
    throw new Error(
      `cannot resolve protected migration baseline: ${source} is not a non-zero full commit SHA`,
    );
  }
  return { revision, source };
}

/**
 * @param {string} root
 * @param {Record<string, string | undefined>} environment
 */
export function resolveProtectedBaselineRevision(root, environment = process.env) {
  if (isGitHubActions(environment)) {
    const { revision, source } = readGitHubBaseline(environment);
    return {
      revision: assertReviewedAncestor(root, revision, source),
      source,
    };
  }

  const configuredRef = environment.AXIS_RELEASE_BASE_REF?.trim();
  const candidates = configuredRef
    ? [{ ref: configuredRef, source: "offline-reviewed-override" }]
    : [
        {
          ref: "refs/remotes/origin/main",
          source: "offline-protected-ref:origin/main",
        },
        { ref: "main", source: "offline-protected-ref:main" },
      ];

  for (const { ref, source } of candidates) {
    if (!gitRefExists(root, ref)) {
      if (configuredRef) {
        throw new Error(
          `cannot resolve protected migration baseline: offline reviewed ref ${ref} does not exist`,
        );
      }
      continue;
    }
    return {
      revision: assertReviewedAncestor(root, ref, `${source}:${ref}`, {
        allowProtectedHeadForDirtyWorktree:
          ref === "refs/remotes/origin/main" && !configuredRef,
      }),
      source: `${source}:${ref}`,
    };
  }

  throw new Error(
    "cannot resolve protected migration baseline: no reviewed ancestor is available; set AXIS_RELEASE_BASE_REF to an explicit reviewed ancestor for offline validation",
  );
}

function readMigrationEntriesAtRevision(root, revision) {
  const files = runGit(root, [
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "--",
    "supabase/migrations",
  ])
    .split("\n")
    .filter(Boolean)
    .sort();

  return files.map((file) => {
    const entry = parseMigrationFilename(file);
    const content = execFileSync("git", ["show", `${revision}:${file}`], {
      cwd: root,
    });
    return { ...entry, sha256: checksum(content) };
  });
}

function readManifestAtRevision(root, revision, manifestRelativePath) {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${manifestRelativePath}`], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    return null;
  }

  try {
    const content = execFileSync(
      "git",
      ["show", `${revision}:${manifestRelativePath}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot read protected migration manifest ${manifestRelativePath} at ${revision}: ${detail}`,
    );
  }
}

/**
 * Load the ledger which the protected base actually contained. A manifest is
 * preferred once it exists; the historical migration tree is the deterministic
 * bootstrap baseline for the first manifest-introducing PR. No base is a hard
 * validation failure, rather than silently trusting the working tree.
 */
export function loadProtectedMigrationBaseline(
  root,
  {
    environment = process.env,
    manifestRelativePath = "scripts/release-migration-manifest.json",
  } = {},
) {
  const { revision, source } = resolveProtectedBaselineRevision(root, environment);
  const treeEntries = readMigrationEntriesAtRevision(root, revision);
  const manifest = readManifestAtRevision(root, revision, manifestRelativePath);

  if (manifest) {
    const errors = validateMigrationManifest(manifest, treeEntries);
    if (errors.length > 0) {
      throw new Error(
        `protected migration baseline ${revision} has an invalid manifest: ${errors.join("; ")}`,
      );
    }
    return { manifest, revision, source, sourceKind: "manifest" };
  }

  return {
    manifest: {
      schemaVersion: 1,
      migrationCount: treeEntries.length,
      latest: treeEntries.at(-1) ?? null,
      migrations: treeEntries,
    },
    revision,
    source,
    sourceKind: "migration-tree",
  };
}

function assertRepositoryPath(root, relativePath, finalKind, label) {
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} has an invalid repository-relative path`);
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    if (!existsSync(current)) {
      throw new Error(`${label} ${relativePath} is missing`);
    }
    const stat = lstatSync(current);
    const isFinal = index === segments.length - 1;
    if (!isFinal && !stat.isDirectory()) {
      throw new Error(
        `${label} ${relativePath} has a non-directory or symlinked parent ${segments.slice(0, index + 1).join("/")}`,
      );
    }
    if (isFinal) {
      const valid =
        finalKind === "file" ? stat.isFile() : stat.isDirectory();
      if (!valid) {
        throw new Error(`${label} ${relativePath} must be a real ${finalKind}`);
      }
    }
  }
  return current;
}

function readRegularJson(root, relativePath, label) {
  const path = assertRepositoryPath(root, relativePath, "file", label);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${label} ${relativePath}: ${detail}`);
  }
}

/**
 * Directory form used by the pull_request_target governance job. Both trees
 * are data-only checkouts; the validator and its YAML parser are loaded from
 * the trusted base checkout.
 */
export function loadMigrationBaselineFromDirectory(
  baseRoot,
  manifestRelativePath = "scripts/release-migration-manifest.json",
) {
  assertRepositoryPath(
    baseRoot,
    "supabase/migrations",
    "directory",
    "protected migration directory",
  );
  const treeEntries = collectMigrationEntries(
    join(baseRoot, "supabase", "migrations"),
  );
  const manifestPath = join(baseRoot, manifestRelativePath);
  if (existsSync(manifestPath)) {
    assertRepositoryPath(
      baseRoot,
      manifestRelativePath,
      "file",
      "protected migration manifest",
    );
    const manifest = readMigrationManifest(manifestPath);
    const errors = validateMigrationManifest(manifest, treeEntries);
    if (errors.length > 0) {
      throw new Error(
        `protected migration baseline has an invalid manifest: ${errors.join("; ")}`,
      );
    }
    return { manifest, sourceKind: "manifest" };
  }
  return {
    manifest: {
      schemaVersion: 1,
      migrationCount: treeEntries.length,
      latest: treeEntries.at(-1) ?? null,
      migrations: treeEntries,
    },
    sourceKind: "migration-tree",
  };
}

function parseWorkflow(content, name) {
  let document;
  try {
    document = yaml.load(content, {
      filename: name,
      schema: yaml.JSON_SCHEMA,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid workflow YAML ${name}: ${detail}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`invalid workflow YAML ${name}: root must be a mapping`);
  }
  return document;
}

function objectHasOnlyKeys(value, allowed) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function actionName(value) {
  return typeof value === "string" ? value.slice(0, value.lastIndexOf("@")) : "";
}

/**
 * pull_request_target runs the base revision's workflow with a token, so its
 * shape is deliberately closed: two pinned checkouts, a trusted dependency
 * install with scripts disabled, and one invocation of the trusted validator.
 * No candidate command, dependency, action, or package script is executed.
 */
export function validateReleaseGovernanceWorkflow(content) {
  const errors = [];
  let document;
  try {
    document = parseWorkflow(content, "release-governance.yml");
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  if (!objectHasOnlyKeys(document, ["name", "on", "permissions", "jobs"])) {
    errors.push("release-governance workflow has unexpected top-level keys");
  }
  const trigger = document.on;
  if (
    !trigger ||
    typeof trigger !== "object" ||
    Array.isArray(trigger) ||
    !Object.hasOwn(trigger, "pull_request_target") ||
    Object.keys(trigger).some((key) => key !== "pull_request_target")
  ) {
    errors.push("release-governance workflow must run only on pull_request_target");
  }
  if (
    !document.permissions ||
    JSON.stringify(document.permissions) !== JSON.stringify({ contents: "read" })
  ) {
    errors.push("release-governance workflow permissions must be exactly contents: read");
  }
  if (
    !document.jobs ||
    typeof document.jobs !== "object" ||
    Array.isArray(document.jobs) ||
    Object.keys(document.jobs).join(",") !== "release-governance"
  ) {
    errors.push("release-governance workflow must contain exactly one release-governance job");
    return errors;
  }

  const job = document.jobs["release-governance"];
  if (!objectHasOnlyKeys(job, ["runs-on", "timeout-minutes", "steps"])) {
    errors.push("release-governance job has unexpected or privilege-bearing keys");
  }
  if (job?.["runs-on"] !== "ubuntu-latest") {
    errors.push("release-governance job must run on ubuntu-latest");
  }
  if (
    typeof job?.["timeout-minutes"] !== "number" ||
    job["timeout-minutes"] > 10
  ) {
    errors.push("release-governance job timeout must be numeric and at most 10 minutes");
  }
  if (!Array.isArray(job?.steps) || job.steps.length !== 5) {
    errors.push("release-governance job must contain exactly five trusted steps");
    return errors;
  }

  const [baseCheckout, setupNode, install, candidateCheckout, validate] = job.steps;
  for (const [index, step] of job.steps.entries()) {
    const allowed = step?.uses
      ? ["name", "uses", "with"]
      : ["name", "run", "working-directory"];
    if (!objectHasOnlyKeys(step, allowed)) {
      errors.push(`release-governance step ${index + 1} has unexpected keys`);
    }
  }

  if (
    actionName(baseCheckout?.uses) !== "actions/checkout" ||
    JSON.stringify(baseCheckout?.with) !==
      JSON.stringify({
        repository: "${{ github.event.pull_request.base.repo.full_name }}",
        ref: "${{ github.event.pull_request.base.sha }}",
        path: "trusted",
        "persist-credentials": false,
        "fetch-depth": 1,
      })
  ) {
    errors.push("release-governance base checkout is not immutable and data-scoped");
  }
  if (
    actionName(setupNode?.uses) !== "actions/setup-node" ||
    JSON.stringify(setupNode?.with) !== JSON.stringify({ "node-version": 24 })
  ) {
    errors.push("release-governance must use the pinned trusted Node 24 setup");
  }
  if (
    install?.run !== "npm ci --ignore-scripts" ||
    install?.["working-directory"] !== "trusted"
  ) {
    errors.push("release-governance may install only trusted base dependencies with scripts disabled");
  }
  if (
    actionName(candidateCheckout?.uses) !== "actions/checkout" ||
    JSON.stringify(candidateCheckout?.with) !==
      JSON.stringify({
        repository: "${{ github.event.pull_request.head.repo.full_name }}",
        ref: "${{ github.event.pull_request.head.sha }}",
        path: "candidate",
        "persist-credentials": false,
        "fetch-depth": 1,
      })
  ) {
    errors.push("release-governance candidate checkout is not immutable and credential-free");
  }
  if (
    validate?.run !==
      "node trusted/scripts/validate-release-candidate.mjs --base=trusted --candidate=candidate" ||
    Object.hasOwn(validate ?? {}, "working-directory")
  ) {
    errors.push("release-governance must invoke only the trusted candidate validator");
  }
  return errors;
}

function validateTrustedControlPlane(baseRoot, candidateRoot) {
  const errors = [];
  const bootstrapPresence = TRUSTED_CONTROL_BOOTSTRAP_FILES.map((file) => {
    const path = join(baseRoot, file);
    return existsSync(path) && lstatSync(path).isFile();
  });
  const isBootstrap = bootstrapPresence.every((present) => !present);
  if (!isBootstrap && bootstrapPresence.some((present) => !present)) {
    errors.push(
      "protected base has an incomplete release control plane; owner break-glass recovery is required",
    );
  }

  for (const file of TRUSTED_CONTROL_PLANE_FILES) {
    const basePath = join(baseRoot, file);
    const candidatePath = join(candidateRoot, file);
    try {
      assertRepositoryPath(
        candidateRoot,
        file,
        "file",
        "trusted control-plane file",
      );
    } catch {
      errors.push(`trusted control-plane file ${file} must remain a regular file`);
      continue;
    }
    if (
      !isBootstrap &&
      existsSync(basePath) &&
      lstatSync(basePath).isFile() &&
      checksum(readFileSync(basePath)) !==
        checksum(readFileSync(candidatePath))
    ) {
      errors.push(
        `trusted control-plane file ${file} differs from the protected base; use the documented owner break-glass procedure`,
      );
    }
  }

  if (!isBootstrap) {
    try {
      const baseWorkflows = directoryFileLedger(
        join(baseRoot, ".github", "workflows"),
      );
      const candidateWorkflows = directoryFileLedger(
        join(candidateRoot, ".github", "workflows"),
      );
      if (
        JSON.stringify(baseWorkflows) !== JSON.stringify(candidateWorkflows)
      ) {
        errors.push(
          "candidate .github/workflows directory differs byte-for-byte from the protected base; use the documented owner break-glass procedure",
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    errors.push(...validateProtectedTestEvolution(baseRoot, candidateRoot));

    try {
      const basePackage = readRegularJson(baseRoot, "package.json", "protected package");
      const candidatePackage = readRegularJson(
        candidateRoot,
        "package.json",
        "candidate package",
      );
      if (
        JSON.stringify(basePackage.scripts ?? {}) !==
        JSON.stringify(candidatePackage.scripts ?? {})
      ) {
        errors.push(
          "candidate package scripts differ from the protected base; release-critical command indirection requires owner break-glass review",
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const file of FORBIDDEN_GATE_OVERRIDE_PATHS) {
    if (existsSync(join(candidateRoot, file))) {
      errors.push(
        `candidate alternate gate/toolchain override ${file} is forbidden; use the documented owner break-glass procedure`,
      );
    }
  }

  errors.push(...validateTrustedYamlParser(candidateRoot));

  try {
    const vercel = readRegularJson(candidateRoot, "vercel.json", "candidate Vercel config");
    if (vercel.ignoreCommand !== REQUIRED_VERCEL_IGNORE_COMMAND) {
      errors.push(
        `vercel.json ignoreCommand must remain exactly ${JSON.stringify(REQUIRED_VERCEL_IGNORE_COMMAND)}`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function validateTrustedYamlParser(root) {
  const errors = [];
  try {
    const candidatePackage = readRegularJson(
      root,
      "package.json",
      "trusted package",
    );
    const candidateLock = readRegularJson(
      root,
      "package-lock.json",
      "trusted package lock",
    );
    const lockRoot = candidateLock?.packages?.[""];
    const lockParser = candidateLock?.packages?.["node_modules/js-yaml"];
    if (
      candidatePackage?.devDependencies?.["js-yaml"] !==
        TRUSTED_YAML_PARSER.specifier ||
      candidatePackage?.overrides?.["js-yaml"] !==
        TRUSTED_YAML_PARSER.specifier ||
      lockRoot?.devDependencies?.["js-yaml"] !==
        TRUSTED_YAML_PARSER.specifier ||
      lockParser?.version !== TRUSTED_YAML_PARSER.version ||
      lockParser?.resolved !== TRUSTED_YAML_PARSER.resolved ||
      lockParser?.integrity !== TRUSTED_YAML_PARSER.integrity
    ) {
      errors.push(
        "trusted js-yaml parser contract must remain pinned to the reviewed 4.3.0 specifier, resolution URL, and integrity",
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function validateGeneratedStateAlignment(baseRoot, candidateRoot) {
  const errors = [];
  let snapshot;
  try {
    snapshot = readRegularJson(
      candidateRoot,
      ".claude/axis-redesign/GENERATED_STATE.json",
      "candidate generated state",
    );
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  let baseHash;
  let candidateHash;
  try {
    baseHash = gitTreeContentHash({ cwd: baseRoot, ref: "HEAD" });
    candidateHash = gitTreeContentHash({ cwd: candidateRoot, ref: "HEAD" });
  } catch (error) {
    return [
      `cannot compute trusted source-state hashes: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  if (snapshot?.git?.contentTreeHash !== candidateHash) {
    errors.push(
      "candidate GENERATED_STATE contentTreeHash does not describe the candidate source tree",
    );
  }
  if (snapshot?.git?.sourceMainContentTreeHash !== baseHash) {
    errors.push(
      "candidate GENERATED_STATE sourceMainContentTreeHash does not match the independently checked-out protected base",
    );
  }
  if (snapshot?.gates?.sourceContentTreeHash !== candidateHash) {
    errors.push(
      "candidate GENERATED_STATE gate evidence is not bound to the candidate source tree",
    );
  }
  const gates = snapshot?.gates;
  if (
    gates?.measured !== true ||
    gates?.contract !== LOCAL_GATE_CONTRACT ||
    typeof gates?.measuredAt !== "string" ||
    !Number.isFinite(Date.parse(gates.measuredAt)) ||
    gates?.typecheck?.passed !== true ||
    gates?.lint?.passed !== true ||
    gates?.build?.passed !== true ||
    gates?.build?.cleanOutput !== true ||
    !Number.isInteger(gates?.tests?.total) ||
    gates.tests.total <= 0 ||
    gates.tests.passed !== gates.tests.total ||
    !Number.isInteger(gates.tests.files) ||
    gates.tests.files <= 0 ||
    !Number.isInteger(gates.tests.suites) ||
    gates.tests.suites <= 0 ||
    !Number.isFinite(gates?.bundleKb?.used) ||
    !Number.isFinite(gates?.bundleKb?.budget) ||
    gates.bundleKb.used < 0 ||
    gates.bundleKb.budget <= 0 ||
    gates.bundleKb.used > gates.bundleKb.budget ||
    !Number.isFinite(gates?.routeIsolatedBundleKb?.used) ||
    !Number.isFinite(gates?.routeIsolatedBundleKb?.budget) ||
    gates.routeIsolatedBundleKb.used < 0 ||
    gates.routeIsolatedBundleKb.budget <= 0 ||
    gates.routeIsolatedBundleKb.used > gates.routeIsolatedBundleKb.budget
  ) {
    errors.push(
      "candidate GENERATED_STATE must contain a complete passing measured-gate shape for its source tree",
    );
  }

  let baseSnapshot;
  try {
    baseSnapshot = readRegularJson(
      baseRoot,
      ".claude/axis-redesign/GENERATED_STATE.json",
      "protected generated state",
    );
    for (const metric of ["total", "files", "suites"]) {
      const baseValue = baseSnapshot?.gates?.tests?.[metric];
      const candidateValue = gates?.tests?.[metric];
      if (
        Number.isInteger(baseValue)
        && (!Number.isInteger(candidateValue) || candidateValue < baseValue)
      ) {
        errors.push(
          `candidate measured test ${metric} ${String(candidateValue)} is below protected-base ${metric} ${baseValue}`,
        );
      }
    }
  } catch (error) {
    errors.push(
      `cannot validate protected-base measured test totals: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (candidateHash === baseHash) {
    try {
      if (
        JSON.stringify(snapshot?.gates) !== JSON.stringify(baseSnapshot?.gates)
      ) {
        errors.push(
          "state-refresh candidate changed gate evidence even though source content is unchanged; preserve the protected measured evidence",
        );
      }
    } catch (error) {
      errors.push(
        `aligned state refresh requires protected gate evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const provenance = {
    branch: snapshot?.git?.branch,
    head: snapshot?.git?.head,
    mainHead: snapshot?.git?.mainHead,
    workingTreeClean: snapshot?.git?.workingTreeClean,
    aheadOfMain: Array.isArray(snapshot?.git?.aheadOfMain)
      ? snapshot.git.aheadOfMain
      : [],
  };
  const expectedFingerprint = stateEvidenceFingerprint(candidateHash, {
    gates: snapshot?.gates,
    provenance,
    sourceMainContentTreeHash: baseHash,
  });
  if (snapshot?.git?.fingerprint !== expectedFingerprint) {
    errors.push(
      "candidate GENERATED_STATE fingerprint is not reproducible by trusted base code",
    );
  }
  return errors;
}

function collectWorkflowScalars(document, key) {
  const values = [];
  const seen = new WeakSet();
  function visit(value, path) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${childKey}` : childKey;
      if (childKey === key) {
        values.push({ value: child, path: childPath });
      }
      visit(child, childPath);
    }
  }
  visit(document, "");
  return values;
}

function workflowFiles(workflowDirectory) {
  if (!existsSync(workflowDirectory)) {
    throw new Error(`missing workflow directory ${workflowDirectory}`);
  }
  if (!lstatSync(workflowDirectory).isDirectory()) {
    throw new Error(`workflow path ${workflowDirectory} must be a real directory`);
  }
  return readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => /\.ya?ml$/i.test(entry.name))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `workflow ${entry.name} must be a regular file (symlinks are forbidden)`,
        );
      }
      return entry.name;
    })
    .sort();
}

function directoryFileLedger(directory) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(`${directory} must be a real directory`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `${directory}/${entry.name} must be a regular file (nested paths and symlinks are forbidden)`,
        );
      }
      return {
        file: entry.name,
        sha256: checksum(readFileSync(join(directory, entry.name))),
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

function trustedTestFileLedger(repositoryRoot) {
  const ledger = [];

  function visit(surface, relativeDirectory) {
    const directory = join(repositoryRoot, relativeDirectory);
    if (!existsSync(directory)) return;
    if (!lstatSync(directory).isDirectory()) {
      throw new Error(`critical test root ${relativeDirectory} must be a real directory`);
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (surface.recursive) visit(surface, relativePath);
        continue;
      }
      if (entry.isFile()) {
        if (surface.include(relativePath)) {
          ledger.push({
            file: relativePath,
            sha256: checksum(readFileSync(join(repositoryRoot, relativePath))),
          });
        }
        continue;
      }
      if (surface.include(relativePath)) {
        throw new Error(
          `critical test file ${relativePath} must be a regular file (symlinks are forbidden)`,
        );
      }
    }
  }

  for (const surface of TRUSTED_TEST_SURFACES) {
    visit(surface, surface.root);
  }
  return ledger.sort((left, right) => left.file.localeCompare(right.file));
}

function validateProtectedTestEvolution(baseRoot, candidateRoot) {
  const errors = [];
  try {
    const baseTests = trustedTestFileLedger(baseRoot);
    const candidateTests = trustedTestFileLedger(candidateRoot);
    const candidateByFile = new Map(
      candidateTests.map((entry) => [entry.file, entry]),
    );

    for (const baseTest of baseTests) {
      const candidateTest = candidateByFile.get(baseTest.file);
      if (!candidateTest) {
        errors.push(
          `candidate removed or renamed protected-base test ${baseTest.file}; test additions are allowed but protected paths must remain`,
        );
      } else if (candidateTest.sha256 !== baseTest.sha256) {
        errors.push(
          `candidate protected-base test ${baseTest.file} differs byte-for-byte from the protected base; use the documented owner break-glass procedure or add a new test file`,
        );
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function containsVercelProductionDeploy(command, productionRequested = false) {
  // Shell continuations and YAML folded blocks become one command. Splitting
  // on command delimiters avoids mistaking `vercel env pull --prod` in one
  // command for an unrelated deploy in a later command.
  const segments = command
    .replace(/\\\r?\n/g, " ")
    .split(/(?:&&|\|\||;|\r?\n)/)
    .map((segment) => segment.replace(/\s+/g, " ").trim());

  return segments.some((segment) => {
    if (!/\bvercel(?:\.cmd)?\b/i.test(segment)) return false;
    const production =
      productionRequested || /(?:^|\s)--prod(?:\s|=|$)/i.test(segment);
    if (!production) return false;
    const suffix = segment
      .slice(segment.search(/\bvercel(?:\.cmd)?\b/i))
      .replace(/^\bvercel(?:\.cmd)?\b/i, "")
      .trim();
    const firstWord = suffix
      .split(/\s+/)
      .find((part) => part && !part.startsWith("-"));
    if (!firstWord) return true;
    if (firstWord.toLowerCase() === "deploy") return true;
    const nonDeployCommands = new Set([
      "alias",
      "bisect",
      "blob",
      "build",
      "certs",
      "curl",
      "dev",
      "dns",
      "domains",
      "env",
      "git",
      "help",
      "init",
      "inspect",
      "integration",
      "link",
      "list",
      "login",
      "logs",
      "project",
      "pull",
      "remove",
      "switch",
      "teams",
      "telemetry",
      "whoami",
    ]);
    // With no recognized subcommand, `vercel [path] --prod` is the CLI's
    // default deploy form.
    return !nonDeployCommands.has(firstWord.toLowerCase());
  });
}

function packageScriptContainsVercelProductionDeploy(
  scripts,
  scriptName,
  seen = new Set(),
  productionRequested = false,
) {
  if (!scripts || typeof scripts !== "object" || seen.has(scriptName)) return false;
  const command = scripts[scriptName];
  if (typeof command !== "string") return false;
  const nextSeen = new Set(seen).add(scriptName);
  if (containsVercelProductionDeploy(command, productionRequested)) return true;

  return invokedPackageScripts(command).some(({ name, productionRequested: nestedProduction }) =>
    packageScriptContainsVercelProductionDeploy(
      scripts,
      name,
      nextSeen,
      productionRequested || nestedProduction,
    ),
  );
}

function invokedPackageScripts(command) {
  const flags = String.raw`(?:\s+--?[A-Za-z][\w-]*(?:=[^\s;&|]+)?)*`;
  const patterns = [
    new RegExp(
      String.raw`\b(?:npm|pnpm)${flags}\s+run${flags}\s+([\w:.-]+)([^\r\n;&|]*)`,
      "g",
    ),
    new RegExp(
      String.raw`\byarn${flags}(?:\s+run)?${flags}\s+([\w:.-]+)([^\r\n;&|]*)`,
      "g",
    ),
    new RegExp(
      String.raw`\bbun${flags}\s+run${flags}\s+([\w:.-]+)([^\r\n;&|]*)`,
      "g",
    ),
  ];
  return patterns.flatMap((pattern) =>
    [...command.matchAll(pattern)].map((match) => ({
      name: match[1],
      productionRequested: /(?:^|\s)--prod(?:\s|=|$)/i.test(match[2]),
    })),
  );
}

function findVercelDeploymentActions(uses) {
  const actions = [];
  for (const { value } of uses) {
    if (typeof value !== "string") continue;
    const action = value.toLowerCase();
    // Actions whose declared purpose is deployment are a second deploy owner
    // even when their input syntax is opaque to static inspection. Deliberately
    // do not flag arbitrary strings containing "vercel" outside `uses:`.
    if (
      /(?:^|\/)(?:vercel(?:[-/].*)?|.*vercel.*(?:deploy|action).*)@/.test(action) ||
      /(?:deploy[-/]to[-/]vercel|vercel[-/]deploy|vercel[-/]action)@/.test(action)
    ) {
      actions.push(value);
    }
  }
  return actions;
}

export function findSecondaryVercelProductionDeploys(
  workflowDirectory,
  { packageScripts = {} } = {},
) {
  const offenders = [];
  for (const name of workflowFiles(workflowDirectory)) {
    const content = readFileSync(join(workflowDirectory, name), "utf8");
    const document = parseWorkflow(content, name);
    const runBlocks = collectWorkflowScalars(document, "run");
    const uses = collectWorkflowScalars(document, "uses");
    const directDeployment = runBlocks.some(
      ({ value }) =>
        typeof value === "string" && containsVercelProductionDeploy(value),
    );
    const scriptDeployment = runBlocks.some(
      ({ value }) =>
        typeof value === "string" &&
        invokedPackageScripts(value).some(({ name, productionRequested }) =>
          packageScriptContainsVercelProductionDeploy(
            packageScripts,
            name,
            new Set(),
            productionRequested,
          ),
        ),
    );
    const deploymentActions = findVercelDeploymentActions(uses);
    if (directDeployment || scriptDeployment || deploymentActions.length > 0) {
      offenders.push(name);
    }
  }
  return offenders;
}

/**
 * Release-critical workflows execute with repository credentials. Pin every
 * third-party action to a 40-character commit so a mutable tag cannot change
 * what runs after review. The accompanying `# vX.Y.Z` comment remains the
 * readable maintenance reference.
 */
export function findMutableGitHubActionReferences(workflowDirectory) {
  const offenders = [];
  for (const name of workflowFiles(workflowDirectory)) {
    const content = readFileSync(join(workflowDirectory, name), "utf8");
    const document = parseWorkflow(content, name);
    const occurrences = new Map();
    for (const { value, path } of collectWorkflowScalars(document, "uses")) {
      if (typeof value !== "string") {
        offenders.push(`${name}:${path}: uses must be a string`);
        continue;
      }
      const reference = value;
      if (reference.startsWith("./")) continue;
      const at = reference.lastIndexOf("@");
      const ref = at === -1 ? "" : reference.slice(at + 1);
      if (!/^[a-f0-9]{40}$/i.test(ref)) {
        offenders.push(`${name}:${path}: ${reference}`);
        continue;
      }
      const occurrence = occurrences.get(reference) ?? 0;
      occurrences.set(reference, occurrence + 1);
      const escapedReference = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const usesReference = new RegExp(
        `\\buses\\s*:\\s*["']?${escapedReference}(?=["'\\s,}\\]])`,
      );
      const matchingLines = content
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => {
          const usesIndex = line.search(usesReference);
          const commentIndex = line.indexOf("#");
          return (
            usesIndex !== -1 &&
            (commentIndex === -1 || usesIndex < commentIndex)
          );
        });
      const source = matchingLines[occurrence];
      if (
        !source ||
        !/#\s*v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*$/.test(source.line)
      ) {
        offenders.push(
          `${name}:${source?.number ?? path}: ${reference} is missing a readable # vX.Y.Z comment`,
        );
      }
    }
  }
  return offenders;
}

export function validateCandidateReleaseGovernance({
  baseRoot,
  candidateRoot,
  governanceWorkflow = ".github/workflows/release-governance.yml",
}) {
  const errors = [];
  try {
    errors.push(...validateTrustedControlPlane(baseRoot, candidateRoot));
    errors.push(...validateGeneratedStateAlignment(baseRoot, candidateRoot));

    const proposedManifest = readRegularJson(
      candidateRoot,
      "scripts/release-migration-manifest.json",
      "candidate migration manifest",
    );
    assertRepositoryPath(
      candidateRoot,
      "supabase/migrations",
      "directory",
      "candidate migration directory",
    );
    const actualMigrations = collectMigrationEntries(
      join(candidateRoot, "supabase", "migrations"),
    );
    errors.push(...validateMigrationManifest(proposedManifest, actualMigrations));
    const baseline = loadMigrationBaselineFromDirectory(baseRoot);
    errors.push(
      ...validateAppendOnlyMigrationManifest(
        baseline.manifest,
        proposedManifest,
      ),
    );

    const packageJson = readRegularJson(candidateRoot, "package.json", "candidate package");
    assertRepositoryPath(
      candidateRoot,
      ".github/workflows",
      "directory",
      "candidate workflow directory",
    );
    const workflowDirectory = join(candidateRoot, ".github", "workflows");
    errors.push(
      ...findSecondaryVercelProductionDeploys(workflowDirectory, {
        packageScripts: packageJson.scripts ?? {},
      }).map(
        (file) =>
          `${file} contains a second production deploy; Vercel Git integration is the sole deploy owner`,
      ),
    );
    errors.push(
      ...findMutableGitHubActionReferences(workflowDirectory).map(
        (reference) => `${reference} uses a mutable or unreadable Action ref`,
      ),
    );

    let governancePath;
    try {
      governancePath = assertRepositoryPath(
        candidateRoot,
        governanceWorkflow,
        "file",
        "release governance workflow",
      );
    } catch {
      errors.push(`${governanceWorkflow} must remain a regular file`);
    }
    if (governancePath) {
      errors.push(
        ...validateReleaseGovernanceWorkflow(
          readFileSync(governancePath, "utf8"),
        ),
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
