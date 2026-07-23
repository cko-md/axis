import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  TRUSTED_CONTROL_BOOTSTRAP_FILES,
  validateCandidateReleaseGovernance,
} from "./release-validation-core.mjs";
import ownerMergeRulesetPayload from "./owner-merge-ruleset.json" with {
  type: "json",
};

export const OWNER_MERGE_APPROVAL_PHRASE =
  "I APPROVE THE EXACT AXIS OWNER MERGE";
export const OWNER_MERGE_EVIDENCE_SCHEMA_VERSION = 1;
// Evidence is operator-supplied. Permit a small clock discrepancy, but never
// accept timestamps that purport to describe validation materially in the future.
export const OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const GITHUB_ACTIONS_APP_ID = 15368;
export const VERCEL_GITHUB_APP_ID = 8329;
export const VERCEL_BOT_ID = 35613825;
export const VERCEL_BOT_LOGIN = "vercel[bot]";
export const VERCEL_BOT_AVATAR =
  "https://avatars.githubusercontent.com/in/8329?v=4";
export const EXPECTED_CI_JOB_NAMES = [
  "docs-currency",
  "runtime-dependency-audit",
  "verify",
  "e2e-smoke",
  "e2e-authenticated",
];
export const EXPECTED_VERCEL_AGGREGATE_CONTEXT =
  "Vercel Deployments – CKO's projects";
export const EXPECTED_VERCEL_DEPLOYMENT_CONTEXT = "Vercel";
export const EXPECTED_OWNER_MERGE_RULESET_TYPES =
  ownerMergeRulesetPayload.rules.map((rule) => rule.type);
export const REQUIRED_MANUAL_CHECK_IDS = [
  "application-error-path",
  "application-happy-path",
  "authorization-and-rls",
  "github-app-installation-permissions",
  "persistence-after-refresh",
  "supabase-and-tembo-impact",
  "vercel-log-secrets-review",
  "vercel-preview",
];
export const OWNER_MERGE_CONTROL_FILES = [
  "scripts/owner-merge.mjs",
  "scripts/owner-merge-core.mjs",
  "scripts/owner-merge-evidence.schema.json",
  "scripts/owner-merge-ruleset.json",
  "docs/axis-redesign/owner-merge-runbook.md",
  "scripts/validate-release-candidate.mjs",
  "scripts/release-validation-core.mjs",
  "scripts/state-tree-integrity.mjs",
  "package.json",
  "package-lock.json",
  ".nvmrc",
  ".github/workflows/ci.yml",
  "playwright.config.ts",
  "tests/e2e/adversarial-rescue.spec.ts",
  "tests/e2e/auth.setup.ts",
  "tests/e2e/authenticated.spec.ts",
  "tests/e2e/ci-smoke.spec.ts",
  "tests/e2e/console-theme-rendering.spec.ts",
  "tests/e2e/operate-authenticated.spec.ts",
  "tests/e2e/production-gate.spec.ts",
  "tests/e2e/smoke.spec.ts",
  "tests/e2e/theme-preferences-authenticated.spec.ts",
  "tests/e2e/vector-authenticated.spec.ts",
  "tests/e2e/workspace-authenticated.spec.ts",
];

const SHA_40 = /^[a-f0-9]{40}$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_EXECUTION_ENV = ["GITHUB_ACTIONS", "VERCEL"];

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail(`${label} contains unexpected keys: ${unexpected.join(", ")}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertIsoDate(value, label) {
  assertNonEmptyString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return timestamp;
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_40.test(value)) {
    fail(`${label} must be a lowercase full 40-character commit SHA`);
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA_256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isInside(parent, target) {
  const rel = relative(parent, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // A prior I/O failure may already have invalidated the descriptor.
  }
}

function descriptorStat(fd) {
  return fstatSync(fd, { bigint: true });
}

function pathStat(path) {
  return statSync(path, { bigint: true });
}

function verifyDescriptorMatchesPath(fd, path, label) {
  let resolved;
  let descriptor;
  let resolvedStat;
  try {
    resolved = realpathSync(path);
    descriptor = descriptorStat(fd);
    resolvedStat = pathStat(resolved);
  } catch {
    fail(`${label} path changed while it was open`);
  }
  if (!sameFile(descriptor, resolvedStat)) {
    fail(`${label} path changed while it was open`);
  }
  return { resolved, stat: descriptor };
}

function readRegularFile(path, label) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = verifyDescriptorMatchesPath(fd, path, label);
    if (!opened.stat.isFile()) {
      fail(`${label} must be a regular non-symlink file`);
    }
    const content = readFileSync(fd);
    verifyDescriptorMatchesPath(fd, path, label);
    return content;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("must be") ||
        error.message.includes("changed while"))
    ) {
      throw error;
    }
    fail(`${label} must be a regular non-symlink file`);
  } finally {
    closeQuietly(fd);
  }
}

export function computeOwnerMergeControlDigest(trustedRoot) {
  const ledger = OWNER_MERGE_CONTROL_FILES.map((file) => {
    const content = readRegularFile(
      join(trustedRoot, file),
      `trusted control file ${file}`,
    );
    return { file, sha256: sha256(content), bytes: content.length };
  });
  return sha256(Buffer.from(canonicalJson(ledger)));
}

export function validateExternalNewReceiptPath(receiptPath, trustedRoot) {
  if (!isAbsolute(receiptPath)) fail("receipt path must be absolute");
  const name = basename(receiptPath);
  if (name === "." || name === ".." || name === "") {
    fail("receipt path must name a file");
  }
  let parentFd;
  try {
    parentFd = openSync(
      dirname(receiptPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = verifyDescriptorMatchesPath(
      parentFd,
      dirname(receiptPath),
      "receipt parent",
    );
    if (!opened.stat.isDirectory()) {
      fail("receipt parent must be an existing non-symlink directory");
    }
    if (isInside(realpathSync(trustedRoot), opened.resolved)) {
      fail("receipt path must be outside the trusted repository");
    }
    return join(opened.resolved, name);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("receipt parent") ||
        error.message.includes("outside the trusted repository"))
    ) {
      throw error;
    }
    fail("receipt parent must be an existing non-symlink directory");
  } finally {
    closeQuietly(parentFd);
  }
}

export function sanitizeOwnerMergeChildEnvironment(
  environment = process.env,
) {
  const sanitized = { ...environment };
  delete sanitized.VERCEL_TOKEN;
  return sanitized;
}

export function sanitizeOwnerMergeGitEnvironment(
  sourceEnvironment = process.env,
) {
  const environment = sanitizeOwnerMergeChildEnvironment(sourceEnvironment);
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function gitEnvironment() {
  return sanitizeOwnerMergeGitEnvironment();
}

function git(cwd, args, options = {}) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      cwd,
      env: gitEnvironment(),
      encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
      input: options.input,
      maxBuffer: 128 * 1024 * 1024,
      stdio: options.stdio,
    },
  );
}

export function verifyTrustedExecutionRoot({
  trustedRoot,
  trustedSha,
  trustedControlDigest,
  environment = process.env,
}) {
  for (const variable of FORBIDDEN_EXECUTION_ENV) {
    if (environment[variable] === "true" || environment[variable] === "1") {
      fail(`owner merge executor refuses to run under ${variable}`);
    }
  }
  const root = realpathSync(trustedRoot);
  const discovered = git(root, ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(discovered) !== root) {
    fail("trusted root must be the top level of its Git worktree");
  }
  assertSha(trustedSha, "trusted SHA");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== trustedSha) {
    fail(`trusted root HEAD ${head} does not equal pinned SHA ${trustedSha}`);
  }
  const type = git(root, ["cat-file", "-t", trustedSha]).trim();
  if (type !== "commit") {
    fail("trusted SHA does not identify a commit");
  }
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    fail("trusted worktree must be completely clean, including untracked files");
  }
  const actualDigest = computeOwnerMergeControlDigest(root);
  if (actualDigest !== trustedControlDigest) {
    fail(
      `trusted control digest ${actualDigest} does not equal independently pinned digest ${trustedControlDigest}`,
    );
  }
  validateFrozenBrowserSemantics(root);
  return { root, head, controlDigest: actualDigest };
}

export function validateFrozenBrowserSemantics(trustedRoot) {
  const workflow = readRegularFile(
    join(trustedRoot, ".github/workflows/ci.yml"),
    "trusted CI workflow",
  ).toString("utf8");
  const publicCommand =
    "npx playwright test --project=public --fail-on-flaky-tests";
  const authenticatedCommand =
    "npx playwright test --project=authenticated --fail-on-flaky-tests";
  if (!workflow.includes(publicCommand)) {
    fail("trusted CI must run the complete public browser project with zero-flake enforcement");
  }
  if (!workflow.includes(authenticatedCommand)) {
    fail(
      "trusted CI must run the complete authenticated browser project with zero-flake enforcement",
    );
  }
  if (/--project=public\s+tests\//.test(workflow)) {
    fail("trusted CI public browser gate must not be narrowed to selected specs");
  }
}

export function readExternalOwnerMergeFile(
  path,
  label,
  trustedRoot,
  { afterValidation } = {},
) {
  if (!isAbsolute(path)) {
    fail(`${label} path must be absolute`);
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = verifyDescriptorMatchesPath(fd, path, label);
    if (!opened.stat.isFile() || opened.stat.nlink !== 1n) {
      fail(`${label} must directly name a regular non-symlink file`);
    }
    const trusted = realpathSync(trustedRoot);
    if (isInside(trusted, opened.resolved)) {
      fail(`${label} must live outside the trusted repository`);
    }
    afterValidation?.(fd);
    const content = readFileSync(fd);
    const after = verifyDescriptorMatchesPath(fd, path, label);
    if (
      opened.stat.size !== after.stat.size ||
      opened.stat.mtimeNs !== after.stat.mtimeNs ||
      opened.stat.ctimeNs !== after.stat.ctimeNs
    ) {
      fail(`${label} changed while it was read`);
    }
    return { content, resolved: opened.resolved };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes(label) ||
        error.message.includes("outside the trusted repository"))
    ) {
      throw error;
    }
    fail(`${label} must directly name a regular non-symlink file`);
  } finally {
    closeQuietly(fd);
  }
}

function validateEvidenceAttachment(attachment, label, trustedRoot) {
  assertObject(attachment, label);
  assertOnlyKeys(attachment, ["path", "sha256"], label);
  const path = assertNonEmptyString(attachment.path, `${label}.path`);
  const { content, resolved } = readExternalOwnerMergeFile(
    path,
    `${label}.path`,
    trustedRoot,
  );
  const expected = assertSha256(attachment.sha256, `${label}.sha256`);
  const actual = sha256(content);
  if (actual !== expected) {
    fail(`${label} digest mismatch`);
  }
  return {
    file: basename(resolved),
    sha256: actual,
    bytes: content.length,
  };
}

export function loadAndValidateOwnerEvidence({
  evidencePath,
  trustedRoot,
  expected,
  previewCreatedAt,
  previewReadyAt,
  currentTime = Date.now(),
}) {
  if (
    !Number.isSafeInteger(previewCreatedAt) ||
    !Number.isSafeInteger(previewReadyAt) ||
    previewCreatedAt < 0 ||
    previewReadyAt < previewCreatedAt
  ) {
    fail("exact Vercel preview timestamps are invalid");
  }
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
    fail("current evidence-validation time is invalid");
  }
  const assertNotMateriallyFuture = (timestamp, label) => {
    if (timestamp > currentTime + OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS) {
      fail(
        `${label} is more than ${OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS / 1000} seconds in the future`,
      );
    }
  };
  const { content: raw, resolved: resolvedEvidence } =
    readExternalOwnerMergeFile(
      evidencePath,
      "owner evidence path",
      trustedRoot,
    );
  let evidence;
  try {
    evidence = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`owner evidence is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertObject(evidence, "owner evidence");
  assertOnlyKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "pullRequest",
      "vercelPreview",
      "trustedReview",
      "sentry",
      "manualValidation",
    ],
    "owner evidence",
  );
  if (evidence.schemaVersion !== OWNER_MERGE_EVIDENCE_SCHEMA_VERSION) {
    fail(`owner evidence schemaVersion must be ${OWNER_MERGE_EVIDENCE_SCHEMA_VERSION}`);
  }

  const repository = assertObject(evidence.repository, "repository evidence");
  assertOnlyKeys(repository, ["id", "owner", "name", "rulesetId"], "repository evidence");
  if (
    repository.id !== expected.repositoryId ||
    repository.owner !== expected.owner ||
    repository.name !== expected.name ||
    repository.rulesetId !== expected.rulesetId
  ) {
    fail("owner evidence repository identity does not match the canonical repository");
  }

  const pullRequest = assertObject(evidence.pullRequest, "pull-request evidence");
  assertOnlyKeys(
    pullRequest,
    ["number", "baseSha", "headSha"],
    "pull-request evidence",
  );
  if (
    pullRequest.number !== expected.prNumber ||
    pullRequest.baseSha !== expected.baseSha ||
    pullRequest.headSha !== expected.headSha
  ) {
    fail("owner evidence is not bound to the exact PR base and head");
  }
  assertSha(pullRequest.baseSha, "evidence base SHA");
  assertSha(pullRequest.headSha, "evidence head SHA");

  const preview = assertObject(
    evidence.vercelPreview,
    "Vercel preview evidence",
  );
  assertOnlyKeys(
    preview,
    [
      "deploymentId",
      "projectId",
      "teamId",
      "headSha",
      "createdAt",
      "readyAt",
    ],
    "Vercel preview evidence",
  );
  if (
    preview.deploymentId !== expected.vercelDeploymentId ||
    preview.projectId !== expected.vercelProjectId ||
    preview.teamId !== expected.vercelTeamId ||
    preview.headSha !== expected.headSha ||
    preview.createdAt !== previewCreatedAt ||
    preview.readyAt !== previewReadyAt
  ) {
    fail("owner evidence is not bound to the exact Ready Vercel preview");
  }
  assertNotMateriallyFuture(preview.createdAt, "vercelPreview.createdAt");
  assertNotMateriallyFuture(preview.readyAt, "vercelPreview.readyAt");
  assertSha(preview.headSha, "Vercel preview head SHA");

  const trustedReview = assertObject(
    evidence.trustedReview,
    "trusted-review evidence",
  );
  assertOnlyKeys(
    trustedReview,
    [
      "kind",
      "trustedSha",
      "controlDigest",
      "reviewedBy",
      "reviewedAt",
      "artifact",
    ],
    "trusted-review evidence",
  );
  const requiredReviewKind = expected.bootstrap
    ? "independent-bootstrap-review"
    : "protected-main-review";
  if (
    trustedReview.kind !== requiredReviewKind ||
    trustedReview.trustedSha !== expected.trustedSha ||
    trustedReview.controlDigest !== expected.trustedControlDigest
  ) {
    fail("trusted-review evidence does not bind the independently pinned control artifact");
  }
  const reviewedBy = assertNonEmptyString(
    trustedReview.reviewedBy,
    "trustedReview.reviewedBy",
  );
  if (reviewedBy.trim().toLowerCase() === expected.owner.toLowerCase()) {
    fail("trusted bootstrap/control reviewer must be independent from the owner operator");
  }
  const reviewedAt = assertIsoDate(
    trustedReview.reviewedAt,
    "trustedReview.reviewedAt",
  );
  assertNotMateriallyFuture(reviewedAt, "trustedReview.reviewedAt");
  const trustedArtifact = validateEvidenceAttachment(
    trustedReview.artifact,
    "trustedReview.artifact",
    trustedRoot,
  );

  const sentry = assertObject(evidence.sentry, "Sentry evidence");
  assertOnlyKeys(
    sentry,
    [
      "windowStart",
      "windowEnd",
      "reviewedAt",
      "reviewedBy",
      "newIssueCount",
      "unresolvedRegressionCount",
      "artifact",
    ],
    "Sentry evidence",
  );
  const windowStart = assertIsoDate(sentry.windowStart, "sentry.windowStart");
  const windowEnd = assertIsoDate(sentry.windowEnd, "sentry.windowEnd");
  const sentryReviewedAt = assertIsoDate(sentry.reviewedAt, "sentry.reviewedAt");
  assertNotMateriallyFuture(windowStart, "sentry.windowStart");
  assertNotMateriallyFuture(windowEnd, "sentry.windowEnd");
  assertNotMateriallyFuture(sentryReviewedAt, "sentry.reviewedAt");
  if (
    windowStart > previewCreatedAt ||
    windowEnd < previewReadyAt ||
    sentryReviewedAt < windowEnd
  ) {
    fail("Sentry evidence window must cover the preview through Ready and be reviewed after the window closes");
  }
  if (sentry.newIssueCount !== 0 || sentry.unresolvedRegressionCount !== 0) {
    fail("Sentry evidence must report zero new issues and zero unresolved regressions");
  }
  assertNonEmptyString(sentry.reviewedBy, "sentry.reviewedBy");
  const sentryArtifact = validateEvidenceAttachment(
    sentry.artifact,
    "sentry.artifact",
    trustedRoot,
  );

  const manual = assertObject(evidence.manualValidation, "manual evidence");
  assertOnlyKeys(manual, ["completedAt", "performedBy", "checks"], "manual evidence");
  const completedAt = assertIsoDate(
    manual.completedAt,
    "manualValidation.completedAt",
  );
  assertNotMateriallyFuture(completedAt, "manualValidation.completedAt");
  if (completedAt < previewReadyAt) {
    fail("manual validation must complete after the exact preview became Ready");
  }
  if (windowEnd < completedAt) {
    fail("Sentry evidence window must cover manual validation completion");
  }
  assertNonEmptyString(manual.performedBy, "manualValidation.performedBy");
  if (!Array.isArray(manual.checks)) {
    fail("manualValidation.checks must be an array");
  }
  const byId = new Map();
  for (const [index, check] of manual.checks.entries()) {
    assertObject(check, `manualValidation.checks[${index}]`);
    assertOnlyKeys(
      check,
      ["id", "outcome", "artifact"],
      `manualValidation.checks[${index}]`,
    );
    const id = assertNonEmptyString(check.id, `manualValidation.checks[${index}].id`);
    if (byId.has(id)) fail(`duplicate manual check ${id}`);
    if (check.outcome !== "pass") {
      fail(`manual check ${id} must have outcome pass`);
    }
    byId.set(
      id,
      validateEvidenceAttachment(
        check.artifact,
        `manualValidation check ${id} artifact`,
        trustedRoot,
      ),
    );
  }
  const missing = REQUIRED_MANUAL_CHECK_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    fail(`manual validation is missing required checks: ${missing.join(", ")}`);
  }

  return {
    digest: sha256(raw),
    file: basename(resolvedEvidence),
    trustedReview: {
      kind: trustedReview.kind,
      reviewedBy,
      reviewedAt: new Date(reviewedAt).toISOString(),
      artifact: trustedArtifact,
    },
    sentry: {
      reviewedAt: new Date(sentryReviewedAt).toISOString(),
      artifact: sentryArtifact,
    },
    manual: {
      completedAt: new Date(completedAt).toISOString(),
      checkArtifacts: Object.fromEntries(byId),
    },
  };
}

export class GhApi {
  constructor({ owner, name }) {
    this.owner = owner;
    this.name = name;
    this.repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  request(method, endpoint, body) {
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      method,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      endpoint,
    ];
    let input;
    if (body !== undefined) {
      args.push("--input", "-");
      input = JSON.stringify(body);
    }
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      input,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...sanitizeOwnerMergeChildEnvironment(),
        GH_DEBUG: "",
      },
    });
    if (output.trim() === "") return null;
    return JSON.parse(output);
  }

  get(endpoint) {
    return this.request("GET", endpoint);
  }

  post(endpoint, body) {
    return this.request("POST", endpoint, body);
  }

  put(endpoint, body) {
    return this.request("PUT", endpoint, body);
  }

  delete(endpoint) {
    return this.request("DELETE", endpoint);
  }

  graphql(query, variables) {
    return this.post("/graphql", { query, variables });
  }

  download(endpoint) {
    return execFileSync(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github+json",
        endpoint,
      ],
      {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        env: {
          ...sanitizeOwnerMergeChildEnvironment(),
          GH_DEBUG: "",
        },
      },
    );
  }
}

function assertNoPagination(array, label) {
  if (!Array.isArray(array)) fail(`${label} response must be an array`);
  if (array.length >= 100) {
    fail(`${label} reached the 100-item safety boundary; pagination must be reviewed`);
  }
  return array;
}

function normalizeProtection(protection) {
  const copy = structuredClone(protection);
  const removeUrls = (value) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (key === "url") delete value[key];
      else removeUrls(value[key]);
    }
  };
  removeUrls(copy);
  return copy;
}

function assertExactArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} must exactly equal ${JSON.stringify(expected)}`);
  }
}

function expectedOwnerMergeRequiredChecks() {
  const statusRule = ownerMergeRulesetPayload.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  if (!statusRule?.parameters?.required_status_checks) {
    fail("trusted owner-merge ruleset payload lacks required status checks");
  }
  return structuredClone(statusRule.parameters.required_status_checks);
}

/**
 * GitHub's ruleset response contains mutable presentation metadata. This
 * deliberately returns only the complete enforcement contract so snapshots,
 * receipts, and the admin-off gate compare policy rather than timestamps/URLs.
 */
export function validateOwnerMergeRuleset({ ruleset, rulesetId, owner, name }) {
  if (!Number.isSafeInteger(rulesetId) || rulesetId <= 0) {
    fail("ruleset ID must be a positive safe integer");
  }
  assertObject(ruleset, "repository ruleset");
  if (
    ruleset.id !== rulesetId ||
    ruleset.name !== ownerMergeRulesetPayload.name ||
    ruleset.target !== "branch" ||
    ruleset.source_type !== "Repository" ||
    ruleset.source !== `${owner}/${name}` ||
    ruleset.enforcement !== "active"
  ) {
    fail("repository ruleset identity, source, target, or enforcement is not canonical");
  }
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    fail("repository ruleset must not grant bypass actors");
  }

  const conditions = assertObject(ruleset.conditions, "repository ruleset conditions");
  assertOnlyKeys(conditions, ["ref_name"], "repository ruleset conditions");
  const refName = assertObject(conditions.ref_name, "repository ruleset ref_name condition");
  assertOnlyKeys(refName, ["include", "exclude"], "repository ruleset ref_name condition");
  assertExactArray(refName.include, ["refs/heads/main"], "repository ruleset ref_name.include");
  assertExactArray(refName.exclude, [], "repository ruleset ref_name.exclude");

  if (!Array.isArray(ruleset.rules) || ruleset.rules.length !== EXPECTED_OWNER_MERGE_RULESET_TYPES.length) {
    fail("repository ruleset must contain exactly the trusted rule set");
  }
  const rulesByType = new Map();
  for (const rule of ruleset.rules) {
    assertObject(rule, "repository ruleset rule");
    assertNonEmptyString(rule.type, "repository ruleset rule type");
    if (!EXPECTED_OWNER_MERGE_RULESET_TYPES.includes(rule.type) || rulesByType.has(rule.type)) {
      fail(`repository ruleset has an unexpected or duplicate rule ${rule.type}`);
    }
    rulesByType.set(rule.type, rule);
  }

  for (const type of ["deletion", "non_fast_forward", "required_linear_history"]) {
    const rule = rulesByType.get(type);
    assertOnlyKeys(rule, ["type", "parameters"], `repository ruleset ${type} rule`);
    if (rule.parameters !== undefined && canonicalJson(rule.parameters) !== "{}") {
      fail(`repository ruleset ${type} rule must not carry parameters`);
    }
  }

  const pullRequest = rulesByType.get("pull_request");
  assertOnlyKeys(pullRequest, ["type", "parameters"], "repository ruleset pull_request rule");
  const pullParameters = assertObject(pullRequest.parameters, "repository ruleset pull_request parameters");
  assertOnlyKeys(
    pullParameters,
    [
      "allowed_merge_methods",
      "dismiss_stale_reviews_on_push",
      "require_code_owner_review",
      "require_last_push_approval",
      "required_approving_review_count",
      "required_review_thread_resolution",
    ],
    "repository ruleset pull_request parameters",
  );
  assertExactArray(
    pullParameters.allowed_merge_methods,
    ["squash"],
    "repository ruleset allowed_merge_methods",
  );
  if (
    pullParameters.required_approving_review_count !== 0 ||
    pullParameters.dismiss_stale_reviews_on_push !== true ||
    pullParameters.require_code_owner_review !== false ||
    pullParameters.require_last_push_approval !== false ||
    pullParameters.required_review_thread_resolution !== true
  ) {
    fail("repository ruleset pull-request review policy is not the trusted conservative policy");
  }

  const statusChecks = rulesByType.get("required_status_checks");
  assertOnlyKeys(statusChecks, ["type", "parameters"], "repository ruleset required_status_checks rule");
  const statusParameters = assertObject(
    statusChecks.parameters,
    "repository ruleset required_status_checks parameters",
  );
  assertOnlyKeys(
    statusParameters,
    [
      "do_not_enforce_on_create",
      "required_status_checks",
      "strict_required_status_checks_policy",
    ],
    "repository ruleset required_status_checks parameters",
  );
  if (
    statusParameters.do_not_enforce_on_create !== false ||
    statusParameters.strict_required_status_checks_policy !== true
  ) {
    fail("repository ruleset status-check enforcement is not strict");
  }
  const expectedChecks = expectedOwnerMergeRequiredChecks();
  const actualChecks = statusParameters.required_status_checks;
  if (!Array.isArray(actualChecks) || actualChecks.length !== expectedChecks.length) {
    fail("repository ruleset has an unexpected required status-check count");
  }
  for (const check of actualChecks) {
    assertObject(check, "repository ruleset required status check");
    assertOnlyKeys(
      check,
      ["context", "integration_id"],
      "repository ruleset required status check",
    );
  }
  const normalizedChecks = actualChecks
    .map((check) => ({ context: check.context, integration_id: check.integration_id }))
    .sort((left, right) => left.context.localeCompare(right.context));
  const normalizedExpectedChecks = [...expectedChecks].sort((left, right) =>
    left.context.localeCompare(right.context),
  );
  if (canonicalJson(normalizedChecks) !== canonicalJson(normalizedExpectedChecks)) {
    fail("repository ruleset required status checks are not the exact trusted App-bound set");
  }

  return {
    id: rulesetId,
    name: ownerMergeRulesetPayload.name,
    target: "branch",
    sourceType: "Repository",
    source: `${owner}/${name}`,
    enforcement: "active",
    bypassActors: [],
    conditions: { refName: { include: ["refs/heads/main"], exclude: [] } },
    rules: {
      deletion: true,
      nonFastForward: true,
      requiredLinearHistory: true,
      pullRequest: {
        allowedMergeMethods: ["squash"],
        dismissStaleReviewsOnPush: true,
        requireCodeOwnerReview: false,
        requireLastPushApproval: false,
        requiredApprovingReviewCount: 0,
        requiredReviewThreadResolution: true,
      },
      requiredStatusChecks: {
        doNotEnforceOnCreate: false,
        strictRequiredStatusChecksPolicy: true,
        checks: normalizedExpectedChecks,
      },
    },
  };
}

export function validateOwnerMergeEffectiveRules({
  rules,
  rulesetId,
  owner,
  name,
}) {
  if (!Array.isArray(rules)) {
    fail("effective main rules response must be an array");
  }
  if (rules.length >= 100) {
    fail(
      "effective main rules reached the 100-item safety boundary; pagination is ambiguous",
    );
  }
  if (rules.length !== EXPECTED_OWNER_MERGE_RULESET_TYPES.length) {
    fail("effective main rules must contain exactly the trusted five-rule set");
  }
  const directRules = rules.map((rule) => {
    assertObject(rule, "effective main rule");
    assertOnlyKeys(
      rule,
      [
        "type",
        "ruleset_source_type",
        "ruleset_source",
        "ruleset_id",
        "parameters",
      ],
      "effective main rule",
    );
    if (
      rule.ruleset_id !== rulesetId ||
      rule.ruleset_source_type !== "Repository" ||
      rule.ruleset_source !== `${owner}/${name}`
    ) {
      fail(
        "effective main rule is not sourced from the exact pinned repository ruleset",
      );
    }
    const normalized = { type: rule.type };
    if (rule.parameters !== undefined) {
      normalized.parameters = rule.parameters;
    }
    return normalized;
  });
  const normalizedRuleset = validateOwnerMergeRuleset({
    ruleset: {
      id: rulesetId,
      name: ownerMergeRulesetPayload.name,
      target: ownerMergeRulesetPayload.target,
      source_type: "Repository",
      source: `${owner}/${name}`,
      enforcement: ownerMergeRulesetPayload.enforcement,
      bypass_actors: ownerMergeRulesetPayload.bypass_actors,
      conditions: ownerMergeRulesetPayload.conditions,
      rules: directRules,
    },
    rulesetId,
    owner,
    name,
  });
  return {
    rulesetId,
    sourceType: "Repository",
    source: `${owner}/${name}`,
    rules: normalizedRuleset.rules,
  };
}

export function validateOwnerMergeRepositoryIdentity({
  repo,
  repositoryId,
  owner,
  name,
}) {
  assertObject(repo, "canonical repository");
  if (
    repo.id !== repositoryId ||
    repo.name !== name ||
    repo.full_name !== `${owner}/${name}` ||
    repo.default_branch !== "main" ||
    repo.visibility !== "public" ||
    repo.private !== false ||
    repo.owner?.login !== owner ||
    repo.owner?.type !== "User" ||
    repo.permissions?.admin !== true
  ) {
    fail(
      "canonical repository numeric ID/full name/default branch/public visibility/admin identity mismatch",
    );
  }
  return {
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    visibility: repo.visibility,
    private: repo.private,
  };
}

export function validateOwnerMergeCollaborators(collaborators, owner) {
  if (!Array.isArray(collaborators)) {
    fail("collaborator inventory must be an array");
  }
  const permissionNames = ["pull", "triage", "push", "maintain", "admin"];
  return collaborators.map((collaborator, index) => {
    assertObject(collaborator, `collaborator inventory[${index}]`);
    const login = assertNonEmptyString(
      collaborator.login,
      `collaborator inventory[${index}].login`,
    );
    const permissions = assertObject(
      collaborator.permissions,
      `collaborator inventory[${index}].permissions`,
    );
    assertOnlyKeys(
      permissions,
      permissionNames,
      `collaborator inventory[${index}].permissions`,
    );
    for (const permission of permissionNames) {
      if (typeof permissions[permission] !== "boolean") {
        fail(
          `collaborator inventory[${index}].permissions.${permission} must be boolean`,
        );
      }
    }
    const canWrite =
      permissions.push || permissions.maintain || permissions.admin;
    if (canWrite && login !== owner) {
      fail(`unexpected write/admin principal ${login}`);
    }
    return {
      login,
      roleName:
        typeof collaborator.role_name === "string"
          ? collaborator.role_name
          : null,
      permissions: Object.fromEntries(
        permissionNames.map((permission) => [
          permission,
          permissions[permission],
        ]),
      ),
    };
  });
}

export function validateOwnerMergeProtection(
  protection,
  expectedAdminState = true,
) {
  if (protection?.lock_branch?.enabled !== true) {
    fail("main must remain locked throughout the owner merge");
  }
  if (protection?.enforce_admins?.enabled !== expectedAdminState) {
    fail(
      `main admin enforcement must be ${expectedAdminState ? "enabled" : "temporarily disabled"}`,
    );
  }
  if (protection?.required_status_checks?.strict !== true) {
    fail("main must require strict up-to-date status checks");
  }
  if (!protection?.required_pull_request_reviews) {
    fail("main must require pull-request review governance");
  }
  const bypass =
    protection.required_pull_request_reviews.bypass_pull_request_allowances;
  assertObject(bypass, "main pull-request bypass allowances");
  assertOnlyKeys(
    bypass,
    ["users", "teams", "apps"],
    "main pull-request bypass allowances",
  );
  for (const kind of ["users", "teams", "apps"]) {
    if (!Array.isArray(bypass[kind]) || bypass[kind].length !== 0) {
      fail(
        "main pull-request bypass allowance users/teams/apps must be explicit empty arrays",
      );
    }
  }
  if (protection?.required_conversation_resolution?.enabled !== true) {
    fail("main must require conversation resolution");
  }
  if (protection?.required_linear_history?.enabled !== true) {
    fail("main must require linear history");
  }
  if (protection?.allow_force_pushes?.enabled !== false) {
    fail("main must prohibit force pushes");
  }
  if (protection?.allow_deletions?.enabled !== false) {
    fail("main must prohibit deletion");
  }
}

function isGitHubTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function latestReviewsAreClear(reviews) {
  if (!Array.isArray(reviews)) {
    fail("review inventory must be an array");
  }
  const allowedStates = new Set([
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
    "PENDING",
  ]);
  const latest = new Map();
  for (const review of reviews) {
    if (
      typeof review?.user?.login !== "string" ||
      review.user.login.trim() === "" ||
      !isGitHubTimestamp(review?.submitted_at) ||
      !allowedStates.has(review?.state)
    ) {
      fail("review inventory contains a malformed review");
    }
    const previous = latest.get(review.user.login);
    if (!previous || Date.parse(previous.submitted_at) < Date.parse(review.submitted_at)) {
      latest.set(review.user.login, review);
    }
  }
  const blocking = [...latest.values()].filter(
    (review) => review.state === "CHANGES_REQUESTED" || review.state === "PENDING",
  );
  if (blocking.length > 0) {
    fail(`PR has unresolved blocking reviews from ${blocking.map((r) => r.user.login).join(", ")}`);
  }
}

export function validatePullRequestReviewState({ reviews, threadResult }) {
  latestReviewsAreClear(reviews);
  assertObject(threadResult, "GraphQL review response");
  if (Object.hasOwn(threadResult, "errors")) {
    fail("GraphQL review response contains errors or partial data");
  }
  const data = assertObject(threadResult.data, "GraphQL review response data");
  const repository = assertObject(
    data.repository,
    "GraphQL review repository",
  );
  const pullRequest = assertObject(
    repository.pullRequest,
    "GraphQL review pull request",
  );
  const threads = assertObject(
    pullRequest.reviewThreads,
    "GraphQL review threads",
  );
  const graphReviews = assertObject(
    pullRequest.reviews,
    "GraphQL reviews",
  );
  if (
    !Array.isArray(threads.nodes) ||
    threads.pageInfo?.hasNextPage !== false ||
    threads.nodes.some(
      (thread) =>
        !thread ||
        typeof thread !== "object" ||
        Array.isArray(thread) ||
        thread.isResolved !== true,
    )
  ) {
    fail("PR has unresolved or unbounded review conversations");
  }
  const allowedGraphStates = new Set([
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
    "PENDING",
  ]);
  if (
    !Array.isArray(graphReviews.nodes) ||
    graphReviews.pageInfo?.hasNextPage !== false ||
    graphReviews.nodes.some(
      (review) =>
        !review ||
        typeof review !== "object" ||
        Array.isArray(review) ||
        !allowedGraphStates.has(review.state) ||
        !isGitHubTimestamp(review.submittedAt) ||
        typeof review.author?.login !== "string" ||
        review.author.login.trim() === "" ||
        review.state === "PENDING" ||
        review.state === "CHANGES_REQUESTED",
    )
  ) {
    fail("PR has unresolved pending or unbounded reviews");
  }
}

function readPullRequestReviewState(gh, { owner, name, prNumber }) {
  const reviews = assertNoPagination(
    gh.get(`${gh.repoPath}/pulls/${prNumber}/reviews?per_page=100`),
    "review inventory",
  );
  const threadResult = gh.graphql(
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{isResolved}
            pageInfo{hasNextPage}
          }
          reviews(first:100){
            nodes{state submittedAt author{login}}
            pageInfo{hasNextPage}
          }
        }
      }
    }`,
    { owner, name, number: prNumber },
  );
  validatePullRequestReviewState({ reviews, threadResult });
}

export function validateVercelDeploymentResponse({
  deployment,
  deploymentId,
  projectId,
  teamId,
  headSha,
}) {
  const deploymentTeamId =
    deployment?.team?.id ?? deployment?.teamId ?? deployment?.ownerId;
  const deploymentProjectId = deployment?.projectId ?? deployment?.project?.id;
  const deploymentSha =
    deployment?.gitSource?.sha ?? deployment?.meta?.githubCommitSha;
  if (
    deployment?.id !== deploymentId ||
    deploymentProjectId !== projectId ||
    deploymentTeamId !== teamId ||
    deploymentSha !== headSha ||
    deployment?.target !== null ||
    deployment?.readyState !== "READY"
  ) {
    fail("Vercel deployment is not the exact Ready preview for the expected team/project/head");
  }
  if (
    !Number.isSafeInteger(deployment.createdAt) ||
    !Number.isSafeInteger(deployment.ready) ||
    deployment.createdAt < 0 ||
    deployment.ready < deployment.createdAt
  ) {
    fail("Vercel deployment lacks valid numeric createdAt/ready timestamps");
  }
  return {
    id: deployment.id,
    url: deployment.url,
    inspectorUrl: deployment.inspectorUrl,
    createdAt: deployment.createdAt,
    readyAt: deployment.ready,
    projectId: deploymentProjectId,
    teamId: deploymentTeamId,
    headSha: deploymentSha,
    readyState: deployment.readyState,
  };
}

async function getVercelDeployment({
  deploymentId,
  projectId,
  teamId,
  headSha,
  token,
  fetchImpl = fetch,
}) {
  if (!token) fail("VERCEL_TOKEN is required for exact preview verification");
  const response = await fetchImpl(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}?teamId=${encodeURIComponent(teamId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
    },
  );
  if (!response.ok) {
    fail(`Vercel deployment verification failed with HTTP ${response.status}`);
  }
  const deployment = await response.json();
  return validateVercelDeploymentResponse({
    deployment,
    deploymentId,
    projectId,
    teamId,
    headSha,
  });
}

function inspectSbomArtifact(gh, artifact, runtimeJob, runId) {
  const artifactCreatedAt = Date.parse(artifact?.created_at);
  const jobStartedAt = Date.parse(runtimeJob?.started_at);
  const jobCompletedAt = Date.parse(runtimeJob?.completed_at);
  if (
    artifact?.name !== "runtime-sbom" ||
    artifact?.expired !== false ||
    !Number.isInteger(artifact?.id) ||
    artifact?.workflow_run?.id !== runId ||
    !Number.isFinite(artifactCreatedAt) ||
    !Number.isFinite(jobStartedAt) ||
    !Number.isFinite(jobCompletedAt) ||
    artifactCreatedAt < jobStartedAt ||
    artifactCreatedAt > jobCompletedAt
  ) {
    fail("runtime SBOM artifact is missing, expired, malformed, or not bound to the exact audit job");
  }
  const zip = gh.download(`${gh.repoPath}/actions/artifacts/${artifact.id}/zip`);
  const temp = mkdtempSync(join(tmpdir(), "axis-owner-merge-sbom-"));
  chmodSync(temp, 0o700);
  const zipPath = join(temp, "runtime-sbom.zip");
  writeFileSync(zipPath, zip, { flag: "wx", mode: 0o600 });
  let names;
  let sbom;
  try {
    names = execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: "C" },
    })
      .trim()
      .split(/\r?\n/);
    if (names.length !== 1 || names[0] !== "sbom.cdx.json") {
      fail("runtime SBOM artifact must contain only sbom.cdx.json");
    }
    sbom = execFileSync("unzip", ["-p", zipPath, "sbom.cdx.json"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: "C" },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(sbom);
  } catch {
    fail("runtime SBOM artifact does not contain valid JSON");
  }
  if (
    parsed?.bomFormat !== "CycloneDX" ||
    parsed?.specVersion !== "1.6" ||
    !Array.isArray(parsed?.components) ||
    parsed.components.length === 0
  ) {
    fail("runtime SBOM does not satisfy the reviewed CycloneDX 1.6 contract");
  }
  return {
    artifactId: artifact.id,
    zipSha256: sha256(zip),
    sbomSha256: sha256(Buffer.from(sbom)),
    components: parsed.components.length,
  };
}

function verifyCheckRun(check, { name, appId, headSha, suiteId }) {
  if (
    !Number.isSafeInteger(check?.id) ||
    check.id <= 0 ||
    check?.name !== name ||
    check?.app?.id !== appId ||
    check?.head_sha !== headSha ||
    check?.status !== "completed" ||
    check?.conclusion !== "success" ||
    (suiteId !== undefined && check?.check_suite?.id !== suiteId)
  ) {
    fail(`required check ${name} is not an exact successful app-bound check`);
  }
}

export function validateRequiredCiCheckRuns({
  checks,
  headSha,
  checkSuiteId,
}) {
  if (!Array.isArray(checks)) {
    fail("CI check-run inventory must be an array");
  }
  if (!Number.isSafeInteger(checkSuiteId) || checkSuiteId <= 0) {
    fail("CI run check_suite_id must be a positive safe integer");
  }
  const normalized = [];
  for (const jobName of EXPECTED_CI_JOB_NAMES) {
    const matches = checks.filter((check) => check.name === jobName);
    if (matches.length !== 1) fail(`required CI check ${jobName} is ambiguous`);
    verifyCheckRun(matches[0], {
      name: jobName,
      appId: GITHUB_ACTIONS_APP_ID,
      headSha,
      suiteId: checkSuiteId,
    });
    normalized.push({
      id: matches[0].id,
      name: jobName,
      appId: GITHUB_ACTIONS_APP_ID,
      headSha,
      checkSuiteId,
      status: "completed",
      conclusion: "success",
    });
  }
  return normalized;
}

function latestCommitStatus(statuses, context) {
  const matches = statuses
    .filter((status) => status?.context === context)
    .map((status) => {
      const createdAt = Date.parse(status?.created_at);
      if (!Number.isInteger(status?.id) || !Number.isFinite(createdAt)) {
        fail(`Vercel status ${context} has an invalid identity or timestamp`);
      }
      return { status, createdAt };
    })
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.status.id - left.status.id,
    );
  if (matches.length === 0) {
    fail(`required Vercel commit status ${context} is missing`);
  }
  if (
    matches.length > 1 &&
    matches[0].createdAt === matches[1].createdAt &&
    matches[0].status.id === matches[1].status.id
  ) {
    fail(`required Vercel commit status ${context} is ambiguous`);
  }
  return matches[0].status;
}

function validateVercelBotStatus(status, context) {
  if (
    status?.context !== context ||
    status?.state !== "success" ||
    status?.creator?.login !== VERCEL_BOT_LOGIN ||
    status?.creator?.id !== VERCEL_BOT_ID ||
    status?.creator?.type !== "Bot" ||
    status?.creator?.avatar_url !== VERCEL_BOT_AVATAR
  ) {
    fail(
      `latest ${context} commit status is not a successful identity-bound Vercel status`,
    );
  }
}

function parseTrustedVercelTarget(targetUrl, label) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    fail(`${label} target URL is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "vercel.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    fail(`${label} target URL must use the canonical Vercel HTTPS origin`);
  }
  return url;
}

export function validateVercelCommitStatuses({
  statuses,
  owner,
  name,
  headSha,
  headBranch,
  deploymentId,
}) {
  if (!Array.isArray(statuses) || statuses.length >= 100) {
    fail("commit-status response is malformed or paginated");
  }
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) {
    fail("Vercel deployment ID must use the canonical dpl_ form");
  }
  const aggregate = latestCommitStatus(
    statuses,
    EXPECTED_VERCEL_AGGREGATE_CONTEXT,
  );
  validateVercelBotStatus(aggregate, EXPECTED_VERCEL_AGGREGATE_CONTEXT);
  const aggregateUrl = parseTrustedVercelTarget(
    aggregate.target_url,
    "aggregate Vercel status",
  );
  if (
    !aggregateUrl.pathname.endsWith("/~/deployments") ||
    aggregateUrl.searchParams.get("repo") !== `github/${owner}/${name}` ||
    aggregateUrl.searchParams.get("filterBranch") !== headBranch ||
    aggregateUrl.searchParams.get("sha") !== headSha ||
    [...aggregateUrl.searchParams.keys()].sort().join(",") !==
      "filterBranch,repo,sha"
  ) {
    fail(
      "aggregate Vercel status target is not bound to the exact repository/branch/head",
    );
  }

  const deployment = latestCommitStatus(
    statuses,
    EXPECTED_VERCEL_DEPLOYMENT_CONTEXT,
  );
  validateVercelBotStatus(deployment, EXPECTED_VERCEL_DEPLOYMENT_CONTEXT);
  const deploymentUrl = parseTrustedVercelTarget(
    deployment.target_url,
    "deployment Vercel status",
  );
  const expectedSuffix = deploymentId.replace(/^dpl_/, "");
  const targetSuffix = deploymentUrl.pathname.split("/").filter(Boolean).at(-1);
  if (
    expectedSuffix === "" ||
    targetSuffix !== expectedSuffix ||
    deploymentUrl.search !== ""
  ) {
    fail(
      "deployment Vercel status target is not bound to the exact deployment ID",
    );
  }
  return {
    aggregate: {
      id: aggregate.id,
      context: aggregate.context,
      targetUrl: aggregateUrl.toString(),
    },
    deployment: {
      id: deployment.id,
      context: deployment.context,
      targetUrl: deploymentUrl.toString(),
    },
  };
}

export async function collectOwnerMergeSnapshot({
  gh,
  repositoryId,
  rulesetId,
  owner,
  name,
  prNumber,
  expectedHeadSha,
  ciWorkflowId,
  ciRunId,
  ciRunAttempt,
  vercelDeploymentId,
  vercelProjectId,
  vercelTeamId,
  vercelToken,
  fetchImpl,
  expectedAdminState = true,
}) {
  const repo = gh.get(gh.repoPath);
  const repository = validateOwnerMergeRepositoryIdentity({
    repo,
    repositoryId,
    owner,
    name,
  });
  const user = gh.get("/user");
  if (user?.login !== owner) {
    fail("authenticated gh identity must be the repository owner");
  }
  const ownerPermission = gh.get(`${gh.repoPath}/collaborators/${encodeURIComponent(owner)}/permission`);
  if (ownerPermission?.permission !== "admin") {
    fail("authenticated owner must have repository admin permission");
  }
  const collaborators = assertNoPagination(
    gh.get(`${gh.repoPath}/collaborators?affiliation=all&per_page=100`),
    "collaborator inventory",
  );
  const principals = validateOwnerMergeCollaborators(collaborators, owner);
  const deployKeys = assertNoPagination(
    gh.get(`${gh.repoPath}/keys?per_page=100`),
    "deploy-key inventory",
  );
  if (deployKeys.length !== 0) {
    fail("repository must have no deploy keys during the owner merge");
  }
  const workflowPermissions = gh.get(`${gh.repoPath}/actions/permissions/workflow`);
  if (
    workflowPermissions?.default_workflow_permissions !== "read" ||
    workflowPermissions?.can_approve_pull_request_reviews !== false
  ) {
    fail("Actions default permissions must be read-only without PR approval authority");
  }

  const mainRef = gh.get(`${gh.repoPath}/git/ref/heads/main`);
  const baseSha = assertSha(mainRef?.object?.sha, "current main SHA");
  const pull = gh.get(`${gh.repoPath}/pulls/${prNumber}`);
  if (
    pull?.number !== prNumber ||
    pull?.state !== "open" ||
    pull?.draft !== false ||
    pull?.base?.ref !== "main" ||
    pull?.base?.repo?.id !== repositoryId ||
    pull?.base?.sha !== baseSha ||
    pull?.head?.repo?.id !== repositoryId ||
    pull?.head?.sha !== expectedHeadSha ||
    pull?.mergeable !== true
  ) {
    fail("PR must be open, non-draft, mergeable, and bound to exact current main/head");
  }
  readPullRequestReviewState(gh, { owner, name, prNumber });

  const workflow = gh.get(`${gh.repoPath}/actions/workflows/${ciWorkflowId}`);
  if (
    workflow?.id !== ciWorkflowId ||
    workflow?.path !== ".github/workflows/ci.yml" ||
    workflow?.state !== "active"
  ) {
    fail("CI workflow numeric ID/path/state does not match the trusted contract");
  }
  const run = gh.get(`${gh.repoPath}/actions/runs/${ciRunId}`);
  const runPr = run?.pull_requests?.find((entry) => entry?.number === prNumber);
  if (
    run?.id !== ciRunId ||
    run?.workflow_id !== ciWorkflowId ||
    run?.path !== ".github/workflows/ci.yml" ||
    run?.event !== "pull_request" ||
    run?.run_attempt !== ciRunAttempt ||
    run?.head_sha !== expectedHeadSha ||
    run?.repository?.id !== repositoryId ||
    run?.head_repository?.id !== repositoryId ||
    run?.status !== "completed" ||
    run?.conclusion !== "success" ||
    runPr?.head?.sha !== expectedHeadSha ||
    runPr?.base?.sha !== baseSha ||
    runPr?.base?.ref !== "main"
  ) {
    fail("CI run is not the exact successful pull_request attempt for this base/head");
  }
  if (!Number.isSafeInteger(run.check_suite_id) || run.check_suite_id <= 0) {
    fail("CI run check_suite_id must be a positive safe integer");
  }
  const jobsPayload = gh.get(
    `${gh.repoPath}/actions/runs/${ciRunId}/attempts/${ciRunAttempt}/jobs?per_page=100`,
  );
  const jobs = jobsPayload?.jobs;
  if (
    !Array.isArray(jobs) ||
    jobsPayload?.total_count !== jobs.length ||
    jobs.length !== EXPECTED_CI_JOB_NAMES.length
  ) {
    fail("CI jobs response is malformed or paginated");
  }
  const jobsByName = new Map(jobs.map((job) => [job.name, job]));
  if (jobsByName.size !== EXPECTED_CI_JOB_NAMES.length) {
    fail("CI jobs response contains duplicate or unexpected jobs");
  }
  for (const jobName of EXPECTED_CI_JOB_NAMES) {
    const job = jobsByName.get(jobName);
    if (
      !Number.isSafeInteger(job?.id) ||
      job.id <= 0 ||
      job?.status !== "completed" ||
      job?.conclusion !== "success" ||
      job?.run_attempt !== ciRunAttempt ||
      job?.head_sha !== expectedHeadSha ||
      job?.workflow_name !== "CI" ||
      job?.steps?.some((step) => !["success", "skipped"].includes(step.conclusion))
    ) {
      fail(`CI job ${jobName} is not an exact zero-failure success`);
    }
  }

  const checkPayload = gh.get(
    `${gh.repoPath}/commits/${expectedHeadSha}/check-runs?filter=latest&per_page=100`,
  );
  if (
    !Array.isArray(checkPayload?.check_runs) ||
    checkPayload.total_count !== checkPayload.check_runs.length ||
    checkPayload.check_runs.length >= 100
  ) {
    fail("check-run response is malformed or paginated");
  }
  const checks = checkPayload.check_runs;
  const normalizedChecks = validateRequiredCiCheckRuns({
    checks,
    headSha: expectedHeadSha,
    checkSuiteId: run.check_suite_id,
  });
  const statuses = assertNoPagination(
    gh.get(
      `${gh.repoPath}/commits/${expectedHeadSha}/statuses?per_page=100`,
    ),
    "commit-status inventory",
  );

  const protection = gh.get(`${gh.repoPath}/branches/main/protection`);
  validateOwnerMergeProtection(protection, expectedAdminState);
  const ruleset = validateOwnerMergeRuleset({
    ruleset: gh.get(`${gh.repoPath}/rulesets/${rulesetId}`),
    rulesetId,
    owner,
    name,
  });
  const effectiveRules = validateOwnerMergeEffectiveRules({
    rules: gh.get(`${gh.repoPath}/rules/branches/main?per_page=100`),
    rulesetId,
    owner,
    name,
  });
  if (canonicalJson(effectiveRules.rules) !== canonicalJson(ruleset.rules)) {
    fail("effective main rules do not match the pinned repository ruleset");
  }
  const requiredChecks = protection.required_status_checks?.checks;
  if (!Array.isArray(requiredChecks)) {
    fail("branch protection must expose app-bound required checks");
  }
  if (
    requiredChecks.some((check) => check.context === "release-governance")
  ) {
    fail(
      "release-governance is evidence-only and its forgeable shared-App context must not be required",
    );
  }
  const expectedRequiredChecks = [
    ...EXPECTED_CI_JOB_NAMES.map((context) => ({
      context,
      app_id: GITHUB_ACTIONS_APP_ID,
    })),
    {
      context: EXPECTED_VERCEL_AGGREGATE_CONTEXT,
      app_id: VERCEL_GITHUB_APP_ID,
    },
  ];
  if (requiredChecks.length !== expectedRequiredChecks.length) {
    fail(
      "branch protection has an unexpected required context; update the trusted owner-merge contract before proceeding",
    );
  }
  for (const expected of expectedRequiredChecks) {
    if (
      !requiredChecks.some(
        (check) =>
          check.context === expected.context && check.app_id === expected.app_id,
      )
    ) {
      fail(`branch protection is missing app-bound required check ${expected.context}`);
    }
  }

  const artifactsPayload = gh.get(
    `${gh.repoPath}/actions/runs/${ciRunId}/artifacts?per_page=100`,
  );
  if (
    !Array.isArray(artifactsPayload?.artifacts) ||
    artifactsPayload.total_count !== artifactsPayload.artifacts.length ||
    artifactsPayload.artifacts.length >= 100
  ) {
    fail("CI artifact response is malformed or paginated");
  }
  const sbomArtifacts = artifactsPayload.artifacts.filter(
    (artifact) => artifact.name === "runtime-sbom",
  );
  if (sbomArtifacts.length !== 1) {
    fail("CI run must contain exactly one runtime-sbom artifact");
  }
  const sbom = inspectSbomArtifact(
    gh,
    sbomArtifacts[0],
    jobsByName.get("runtime-dependency-audit"),
    ciRunId,
  );
  const vercel = await getVercelDeployment({
    deploymentId: vercelDeploymentId,
    projectId: vercelProjectId,
    teamId: vercelTeamId,
    headSha: expectedHeadSha,
    token: vercelToken,
    fetchImpl,
  });
  vercel.statuses = validateVercelCommitStatuses({
    statuses,
    owner,
    name,
    headSha: expectedHeadSha,
    headBranch: pull.head.ref,
    deploymentId: vercel.id,
  });

  return {
    repository,
    identity: user.login,
    principals,
    deployKeyCount: deployKeys.length,
    baseSha,
    headSha: expectedHeadSha,
    prNumber,
    ci: {
      workflowId: ciWorkflowId,
      runId: ciRunId,
      runAttempt: ciRunAttempt,
      checkSuiteId: run.check_suite_id,
      jobs: EXPECTED_CI_JOB_NAMES.map((jobName) => ({
        name: jobName,
        id: jobsByName.get(jobName).id,
      })),
      checks: normalizedChecks,
      sbom,
    },
    vercel,
    protection: normalizeProtection(protection),
    ruleset,
    effectiveRules,
  };
}

function materializeGitRevision({ owner, name, sha, label }) {
  assertSha(sha, `${label} SHA`);
  const temp = mkdtempSync(join(tmpdir(), `axis-owner-merge-${label}-`));
  chmodSync(temp, 0o700);
  const gitDir = join(temp, "objects.git");
  const tree = join(temp, "tree");
  mkdirSync(tree, { mode: 0o700 });
  git(temp, ["init", "--bare", gitDir]);
  git(temp, [
    `--git-dir=${gitDir}`,
    "fetch",
    "--no-tags",
    "--depth=1",
    "--no-recurse-submodules",
    `https://github.com/${owner}/${name}.git`,
    `+${sha}:refs/heads/materialized`,
  ]);
  const fetched = git(temp, [
    `--git-dir=${gitDir}`,
    "rev-parse",
    "refs/heads/materialized",
  ]).trim();
  if (fetched !== sha) fail(`${label} fetch did not resolve to the exact SHA`);
  git(temp, [
    `--git-dir=${gitDir}`,
    "symbolic-ref",
    "HEAD",
    "refs/heads/materialized",
  ]);
  const archive = git(
    temp,
    [`--git-dir=${gitDir}`, "archive", "--format=tar", sha],
    { encoding: "buffer" },
  );
  execFileSync("tar", ["-xf", "-", "-C", tree], {
    input: archive,
    maxBuffer: 128 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  writeFileSync(join(tree, ".git"), `gitdir: ${gitDir}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return { temp, tree };
}

export function validateCandidateAsInertData({
  trustedRoot,
  owner,
  name,
  baseSha,
  headSha,
  bootstrap,
  materialize = materializeGitRevision,
}) {
  const base = materialize({ owner, name, sha: baseSha, label: "base" });
  const candidate = materialize({
    owner,
    name,
    sha: headSha,
    label: "candidate",
  });
  try {
    if (bootstrap) {
      if (headSha !== git(trustedRoot, ["rev-parse", "HEAD"]).trim()) {
        fail("bootstrap trusted artifact must be the exact candidate head");
      }
      const bootstrapBaseFiles = TRUSTED_CONTROL_BOOTSTRAP_FILES.filter((file) =>
        existsSync(join(base.tree, file)),
      );
      if (bootstrapBaseFiles.length > 0) {
        fail(
          "bootstrap mode is permanently unavailable after any trusted control has landed on main",
        );
      }
      if (
        lstatSync(join(candidate.tree, "scripts", "owner-merge.mjs")).isFile() !==
          true
      ) {
        fail("bootstrap candidate lacks the owner merge executor");
      }
    } else if (baseSha !== git(trustedRoot, ["rev-parse", "HEAD"]).trim()) {
      fail("normal owner merge must execute from the exact current protected main SHA");
    }
    const errors = validateCandidateReleaseGovernance({
      baseRoot: base.tree,
      candidateRoot: candidate.tree,
    });
    if (errors.length > 0) {
      fail(`trusted-base candidate validation failed: ${errors.join("; ")}`);
    }
    return { baseSha, headSha, passed: true };
  } finally {
    rmSync(candidate.temp, { recursive: true, force: true });
    rmSync(base.temp, { recursive: true, force: true });
  }
}

function snapshotsMatch(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function adminOffSnapshotMatches(protectedSnapshot, adminOffSnapshot) {
  const normalized = structuredClone(adminOffSnapshot);
  if (normalized?.protection?.enforce_admins?.enabled !== false) {
    return false;
  }
  normalized.protection.enforce_admins =
    protectedSnapshot.protection.enforce_admins;
  return snapshotsMatch(protectedSnapshot, normalized);
}

function validateVerifiedSnapshot(verification, label) {
  assertObject(verification, label);
  assertOnlyKeys(
    verification,
    ["snapshot", "evidenceSha256", "trusted"],
    label,
  );
  assertObject(verification.snapshot, `${label}.snapshot`);
  assertSha256(verification.evidenceSha256, `${label}.evidenceSha256`);
  const trusted = assertObject(verification.trusted, `${label}.trusted`);
  assertOnlyKeys(trusted, ["sha", "controlDigest"], `${label}.trusted`);
  assertSha(trusted.sha, `${label}.trusted.sha`);
  assertSha256(
    trusted.controlDigest,
    `${label}.trusted.controlDigest`,
  );
  return verification;
}

function verificationBindingsMatch(left, right) {
  return (
    left.evidenceSha256 === right.evidenceSha256 &&
    canonicalJson(left.trusted) === canonicalJson(right.trusted)
  );
}

function snapshotSha256(snapshot) {
  return sha256(Buffer.from(canonicalJson(snapshot)));
}

async function delay(milliseconds) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function restoreAdminEnforcement({
  gh,
  originalProtection,
  retries = 6,
  delayImpl = delay,
}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      gh.post(`${gh.repoPath}/branches/main/protection/enforce_admins`);
      const restored = gh.get(`${gh.repoPath}/branches/main/protection`);
      validateOwnerMergeProtection(restored, true);
      if (
        canonicalJson(normalizeProtection(restored)) !==
        canonicalJson(originalProtection)
      ) {
        fail("branch protection was not restored byte-for-byte after owner merge");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) {
        await delayImpl(250 * 2 ** attempt);
      }
    }
  }
  fail(
    `CRITICAL: unable to restore main admin enforcement: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function executeProtectedOwnerMerge({
  gh,
  initialSnapshot,
  reread,
  adminOffReread,
  recordCriticalVerification,
  expectedHeadSha,
  owner,
  prNumber,
  restoreOptions = {},
}) {
  let immediate;
  try {
    immediate = validateVerifiedSnapshot(
      await reread(),
      "second verified owner-merge snapshot",
    );
    if (!snapshotsMatch(initialSnapshot, immediate.snapshot)) {
      fail("remote evidence changed before the merge critical section");
    }
  } catch (error) {
    const wrapped = new Error(
      "owner merge aborted before GitHub accepted a merge",
      { cause: error },
    );
    wrapped.ownerMergeOutcome = "NOT_MERGED";
    wrapped.ownerMergeFailureCode = "PRE_MERGE_REREAD_FAILED";
    throw wrapped;
  }
  const originalProtection = immediate.snapshot.protection;
  let disabled = false;
  let mergeAttempted = false;
  let mergeExplicitlyRejected = false;
  let restorationFailed = false;
  let mergeResponse;
  let transactionError;
  let criticalVerification;
  try {
    // Deliberately mutate only admin enforcement. There is no code path which
    // writes lock_branch=false or replaces the full protection document.
    disabled = true;
    gh.delete(`${gh.repoPath}/branches/main/protection/enforce_admins`);
    const recorded = validateVerifiedSnapshot(
      await adminOffReread(),
      "recorded admin-off owner-merge snapshot",
    );
    if (
      !adminOffSnapshotMatches(immediate.snapshot, recorded.snapshot) ||
      !verificationBindingsMatch(immediate, recorded)
    ) {
      fail("complete remote evidence changed after admin enforcement was disabled");
    }
    const recordedSnapshotSha256 = snapshotSha256(recorded.snapshot);
    criticalVerification = {
      schemaVersion: 1,
      event: "CRITICAL_VERIFIED",
      recordedAt: new Date().toISOString(),
      secondSnapshotSha256: snapshotSha256(immediate.snapshot),
      adminOffSnapshotSha256: recordedSnapshotSha256,
      ownerEvidenceSha256: recorded.evidenceSha256,
      trusted: recorded.trusted,
      effectiveRulesSha256: sha256(
        Buffer.from(canonicalJson(recorded.snapshot.effectiveRules)),
      ),
      mainLocked: true,
      adminEnforcement: false,
    };
    await recordCriticalVerification(criticalVerification);

    // The complete read after the durable record is the last remote operation
    // before the exact merge PUT. It covers hosted checks, Vercel, external
    // evidence/trust, direct/effective rules, protection, ref, PR, and reviews.
    const finalGate = validateVerifiedSnapshot(
      await adminOffReread(),
      "final admin-off owner-merge snapshot",
    );
    if (
      !snapshotsMatch(recorded.snapshot, finalGate.snapshot) ||
      !verificationBindingsMatch(recorded, finalGate)
    ) {
      fail("complete remote evidence changed after the durable critical record");
    }
    if (snapshotSha256(finalGate.snapshot) !== recordedSnapshotSha256) {
      fail("final owner-merge snapshot digest does not match the durable record");
    }
    criticalVerification.finalSnapshotSha256 =
      snapshotSha256(finalGate.snapshot);
    mergeAttempted = true;
    mergeResponse = gh.put(`${gh.repoPath}/pulls/${prNumber}/merge`, {
      sha: expectedHeadSha,
      merge_method: "squash",
    });
    if (mergeResponse?.merged !== true) {
      mergeExplicitlyRejected = mergeResponse?.merged === false;
      fail("GitHub refused the exact owner squash merge");
    }
  } catch (error) {
    transactionError = error;
  } finally {
    if (disabled) {
      try {
        await restoreAdminEnforcement({
          gh,
          originalProtection,
          ...restoreOptions,
        });
      } catch (restoreError) {
        restorationFailed = true;
        transactionError = restoreError;
      }
    }
  }
  if (transactionError) {
    const wrapped = new Error(
      restorationFailed
        ? "CRITICAL: main admin-enforcement restoration failed; merge outcome requires reconciliation"
        : mergeAttempted && !mergeExplicitlyRejected
          ? "owner merge request outcome requires reconciliation"
          : "owner merge aborted before GitHub accepted a merge",
      { cause: transactionError },
    );
    wrapped.ownerMergeOutcome =
      restorationFailed || (mergeAttempted && !mergeExplicitlyRejected)
        ? "UNKNOWN"
        : "NOT_MERGED";
    wrapped.ownerMergeFailureCode = restorationFailed
      ? "ADMIN_ENFORCEMENT_RESTORE_FAILED"
      : mergeAttempted
        ? "MERGE_REQUEST_FAILED"
        : "PRE_MERGE_CHECK_FAILED";
    throw wrapped;
  }

  try {
    const mergedSha = assertSha(mergeResponse.sha, "merge response SHA");
    const finalRef = gh.get(`${gh.repoPath}/git/ref/heads/main`);
    const mergedPr = gh.get(`${gh.repoPath}/pulls/${prNumber}`);
    const mergeCommit = gh.get(`${gh.repoPath}/git/commits/${mergedSha}`);
    const headCommit = gh.get(`${gh.repoPath}/git/commits/${expectedHeadSha}`);
    if (
      finalRef?.object?.sha !== mergedSha ||
      mergedPr?.merged !== true ||
      mergedPr?.merge_commit_sha !== mergedSha ||
      mergedPr?.merged_by?.login !== owner ||
      mergeCommit?.sha !== mergedSha ||
      mergeCommit?.tree?.sha !== headCommit?.tree?.sha ||
      mergeCommit?.parents?.length !== 1 ||
      mergeCommit.parents[0]?.sha !== initialSnapshot.baseSha
    ) {
      fail("post-merge SHA/tree/method/owner verification failed");
    }
    const finalProtection = gh.get(`${gh.repoPath}/branches/main/protection`);
    validateOwnerMergeProtection(finalProtection, true);
    if (
      canonicalJson(normalizeProtection(finalProtection)) !==
      canonicalJson(originalProtection)
    ) {
      fail("final branch protection does not match the pre-merge protection");
    }
    const finalRuleset = validateOwnerMergeRuleset({
      ruleset: gh.get(
        `${gh.repoPath}/rulesets/${immediate.snapshot.ruleset.id}`,
      ),
      rulesetId: immediate.snapshot.ruleset.id,
      owner,
      name: initialSnapshot.repository.name,
    });
    if (
      canonicalJson(finalRuleset) !==
      canonicalJson(immediate.snapshot.ruleset)
    ) {
      fail("final repository ruleset does not match the pre-merge ruleset");
    }
    const finalEffectiveRules = validateOwnerMergeEffectiveRules({
      rules: gh.get(`${gh.repoPath}/rules/branches/main?per_page=100`),
      rulesetId: immediate.snapshot.ruleset.id,
      owner,
      name: initialSnapshot.repository.name,
    });
    if (
      canonicalJson(finalEffectiveRules) !==
      canonicalJson(immediate.snapshot.effectiveRules)
    ) {
      fail("final effective main rules do not match the pre-merge rules");
    }
    return {
      mergedSha,
      treeSha: mergeCommit.tree.sha,
      parentSha: mergeCommit.parents[0].sha,
      method: "squash",
      mergedBy: mergedPr.merged_by.login,
      criticalVerification: {
        secondSnapshotSha256:
          criticalVerification.secondSnapshotSha256,
        adminOffSnapshotSha256:
          criticalVerification.adminOffSnapshotSha256,
        finalSnapshotSha256:
          criticalVerification.finalSnapshotSha256,
        ownerEvidenceSha256:
          criticalVerification.ownerEvidenceSha256,
        effectiveRulesSha256:
          criticalVerification.effectiveRulesSha256,
      },
    };
  } catch (error) {
    const wrapped = new Error(
      "owner merge was accepted but final state requires reconciliation",
      { cause: error },
    );
    wrapped.ownerMergeOutcome = "UNKNOWN";
    wrapped.ownerMergeFailureCode = "POST_MERGE_VERIFICATION_FAILED";
    throw wrapped;
  }
}

function writeAll(fd, content) {
  let offset = 0;
  while (offset < content.length) {
    const written = writeSync(
      fd,
      content,
      offset,
      content.length - offset,
      null,
    );
    if (written <= 0) fail("receipt journal write made no progress");
    offset += written;
  }
}

function verifyOpenJournal(journal) {
  const openedParent = verifyDescriptorMatchesPath(
    journal.parentFd,
    journal.parent,
    "receipt journal parent",
  );
  const opened = verifyDescriptorMatchesPath(
    journal.fd,
    journal.path,
    "receipt journal",
  );
  if (
    !openedParent.stat.isDirectory() ||
    openedParent.resolved !== journal.parent ||
    !opened.stat.isFile() ||
    opened.stat.nlink !== 1n ||
    opened.resolved !== journal.path ||
    !sameFile(opened.stat, journal.fileStat)
  ) {
    fail("receipt journal path or inode changed");
  }
}

export function prepareOwnerMergeJournal(
  receiptPath,
  trustedRoot,
  preparedIntent,
) {
  assertObject(preparedIntent, "PREPARED receipt intent");
  if (
    preparedIntent.schemaVersion !== 1 ||
    preparedIntent.event !== "PREPARED"
  ) {
    fail("receipt journal must begin with a schemaVersion 1 PREPARED intent");
  }
  const path = validateExternalNewReceiptPath(receiptPath, trustedRoot);
  const parent = dirname(path);
  let parentFd;
  let fd;
  try {
    parentFd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedParent = verifyDescriptorMatchesPath(
      parentFd,
      parent,
      "receipt parent",
    );
    if (
      !openedParent.stat.isDirectory() ||
      openedParent.resolved !== parent ||
      isInside(realpathSync(trustedRoot), openedParent.resolved)
    ) {
      fail("receipt journal parent is not the validated external directory");
    }
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const fileStat = descriptorStat(fd);
    const journal = {
      path,
      parent,
      parentFd,
      fd,
      fileStat,
      preparedContent: Buffer.from(`${JSON.stringify(preparedIntent)}\n`),
      contents: [],
      criticalRecorded: false,
      closed: false,
    };
    verifyOpenJournal(journal);
    writeAll(fd, journal.preparedContent);
    fsyncSync(fd);
    fsyncSync(parentFd);
    journal.contents.push(journal.preparedContent);
    verifyOpenJournal(journal);
    return journal;
  } catch (error) {
    closeQuietly(fd);
    closeQuietly(parentFd);
    throw error;
  }
}

export function closeOwnerMergeJournal(journal) {
  if (!journal || journal.closed) return;
  closeQuietly(journal.fd);
  closeQuietly(journal.parentFd);
  journal.closed = true;
}

function sealOwnerMergeJournalAfterFailure(journal) {
  if (!journal || journal.closed) return;
  try {
    fsyncSync(journal.fd);
  } catch {
    // Preserve the original finalization failure while attempting every seal.
  }
  try {
    fchmodSync(journal.fd, 0o400);
  } catch {
    // Preserve the original finalization failure while attempting every seal.
  }
  try {
    fsyncSync(journal.fd);
  } catch {
    // Preserve the original finalization failure while attempting every seal.
  }
  try {
    fsyncSync(journal.parentFd);
  } catch {
    // Preserve the original finalization failure while attempting every seal.
  }
  closeOwnerMergeJournal(journal);
}

export function appendOwnerMergeCriticalVerification(journal, verification) {
  if (!journal || journal.closed) fail("receipt journal is not open");
  assertObject(verification, "CRITICAL_VERIFIED journal record");
  if (
    verification.schemaVersion !== 1 ||
    verification.event !== "CRITICAL_VERIFIED"
  ) {
    fail(
      "critical journal record must be a schemaVersion 1 CRITICAL_VERIFIED record",
    );
  }
  if (journal.criticalRecorded) {
    fail("receipt journal already contains a critical verification record");
  }
  const content = Buffer.from(`${JSON.stringify(verification)}\n`);
  verifyOpenJournal(journal);
  writeAll(journal.fd, content);
  fsyncSync(journal.fd);
  fsyncSync(journal.parentFd);
  verifyOpenJournal(journal);
  journal.contents.push(content);
  journal.criticalRecorded = true;
  return {
    sha256: sha256(content),
  };
}

export function finalizeOwnerMergeJournal(journal, outcome) {
  if (!journal || journal.closed) fail("receipt journal is not open");
  const outcomeContent = Buffer.from(`${JSON.stringify(outcome)}\n`);
  verifyOpenJournal(journal);
  writeAll(journal.fd, outcomeContent);
  fsyncSync(journal.fd);
  fchmodSync(journal.fd, 0o400);
  fsyncSync(journal.fd);
  fsyncSync(journal.parentFd);
  verifyOpenJournal(journal);
  closeOwnerMergeJournal(journal);
  journal.contents.push(outcomeContent);
  return {
    path: journal.path,
    sha256: sha256(Buffer.concat(journal.contents)),
  };
}

export function buildOwnerMergePreparedIntent({
  trusted,
  snapshot,
  evidence,
  inertValidation,
  bootstrap,
  approvalPhrase,
}) {
  if (approvalPhrase !== OWNER_MERGE_APPROVAL_PHRASE) {
    fail("PREPARED intent requires the exact owner approval phrase");
  }
  return {
    schemaVersion: 1,
    event: "PREPARED",
    recordedAt: new Date().toISOString(),
    mode: bootstrap ? "owner-bootstrap-exception" : "owner-protected-main",
    approval: {
      exactPhraseSha256: sha256(Buffer.from(approvalPhrase)),
    },
    trusted: {
      sha: trusted.head,
      controlDigest: trusted.controlDigest,
      reviewKind: evidence.trustedReview.kind,
      reviewArtifactSha256: evidence.trustedReview.artifact.sha256,
    },
    repository: snapshot.repository,
    remoteSnapshotSha256: sha256(
      Buffer.from(canonicalJson(snapshot)),
    ),
    pullRequest: {
      number: snapshot.prNumber,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    },
    evidence: {
      ownerEvidenceSha256: evidence.digest,
      sentryArtifactSha256: evidence.sentry.artifact.sha256,
      manualArtifactSha256s: Object.fromEntries(
        Object.entries(evidence.manual.checkArtifacts).map(([id, artifact]) => [
          id,
          artifact.sha256,
        ]),
      ),
    },
    hosted: {
      ciWorkflowId: snapshot.ci.workflowId,
      ciRunId: snapshot.ci.runId,
      ciRunAttempt: snapshot.ci.runAttempt,
      runtimeSbomZipSha256: snapshot.ci.sbom.zipSha256,
      runtimeSbomSha256: snapshot.ci.sbom.sbomSha256,
      vercelDeploymentId: snapshot.vercel.id,
      vercelProjectId: snapshot.vercel.projectId,
      vercelTeamId: snapshot.vercel.teamId,
      vercelCreatedAt: snapshot.vercel.createdAt,
      vercelReadyAt: snapshot.vercel.readyAt,
      vercelAggregateStatusId: snapshot.vercel.statuses.aggregate.id,
      vercelDeploymentStatusId: snapshot.vercel.statuses.deployment.id,
    },
    governanceRuleset: snapshot.ruleset,
    effectiveRules: snapshot.effectiveRules,
    candidateValidation: inertValidation,
  };
}

function safeFailureOutcome(error) {
  const notMerged = error?.ownerMergeOutcome === "NOT_MERGED";
  return {
    schemaVersion: 1,
    event: notMerged ? "ABORTED" : "RECONCILIATION_REQUIRED",
    recordedAt: new Date().toISOString(),
    mergeOutcome: notMerged ? "NOT_MERGED" : "UNKNOWN",
    failureCode:
      typeof error?.ownerMergeFailureCode === "string"
        ? error.ownerMergeFailureCode
        : "UNCLASSIFIED_MERGE_FAILURE",
  };
}

export async function executeOwnerMergeWithJournal({
  receiptPath,
  trustedRoot,
  preparedIntent,
  executeMerge,
  buildSuccessOutcome,
  finalizeJournal = finalizeOwnerMergeJournal,
  appendCriticalVerification = appendOwnerMergeCriticalVerification,
}) {
  const journal = prepareOwnerMergeJournal(
    receiptPath,
    trustedRoot,
    preparedIntent,
  );
  let merge;
  let criticalWriteFailed = false;
  try {
    merge = await executeMerge({
      recordCriticalVerification: (verification) => {
        try {
          return appendCriticalVerification(journal, verification);
        } catch (error) {
          criticalWriteFailed = true;
          sealOwnerMergeJournalAfterFailure(journal);
          throw error;
        }
      },
    });
    if (!journal.criticalRecorded) {
      const error = new Error(
        "merge callback returned without a durable critical verification record",
      );
      error.ownerMergeOutcome = "UNKNOWN";
      error.ownerMergeFailureCode = "CRITICAL_VERIFICATION_NOT_RECORDED";
      throw error;
    }
  } catch (error) {
    if (criticalWriteFailed) {
      const restorationFailed =
        error?.ownerMergeFailureCode ===
          "ADMIN_ENFORCEMENT_RESTORE_FAILED" &&
        error?.ownerMergeOutcome === "UNKNOWN";
      const wrapped = new Error(
        restorationFailed
          ? "CRITICAL: durable CRITICAL_VERIFIED journal write and main admin-enforcement restoration both failed; merge outcome UNKNOWN; preserve the sealed PREPARED journal and reconcile protection"
          : "owner merge aborted before PUT because the durable CRITICAL_VERIFIED record failed; preserve the sealed PREPARED journal",
        { cause: error },
      );
      wrapped.ownerMergeOutcome = restorationFailed
        ? "UNKNOWN"
        : "NOT_MERGED";
      wrapped.ownerMergeFailureCode = restorationFailed
        ? "ADMIN_ENFORCEMENT_RESTORE_FAILED"
        : "CRITICAL_VERIFICATION_WRITE_FAILED";
      throw wrapped;
    }
    const outcome = safeFailureOutcome(error);
    try {
      finalizeJournal(journal, outcome);
    } catch {
      sealOwnerMergeJournalAfterFailure(journal);
      const wrapped = new Error(
        outcome.failureCode === "ADMIN_ENFORCEMENT_RESTORE_FAILED"
          ? "CRITICAL: main admin-enforcement restoration and receipt finalization both failed; merge outcome UNKNOWN; preserve the sealed journal and reconcile protection"
          : "owner merge failed and receipt finalization failed; merge outcome may require reconciliation; the durable PREPARED journal must be reconciled",
        { cause: error },
      );
      wrapped.ownerMergeOutcome = outcome.mergeOutcome;
      wrapped.ownerMergeFailureCode = outcome.failureCode;
      throw wrapped;
    }
    const wrapped = new Error(
      outcome.mergeOutcome === "NOT_MERGED"
        ? "owner merge aborted before GitHub accepted a merge; the receipt journal records ABORTED"
        : "owner merge outcome may require reconciliation; the receipt journal records RECONCILIATION_REQUIRED",
      { cause: error },
    );
    wrapped.ownerMergeOutcome = outcome.mergeOutcome;
    wrapped.ownerMergeFailureCode = outcome.failureCode;
    throw wrapped;
  }

  try {
    const outcome = buildSuccessOutcome(merge);
    const written = finalizeJournal(journal, outcome);
    return { merge, written };
  } catch {
    sealOwnerMergeJournalAfterFailure(journal);
    const wrapped = new Error(
      "owner merge completed but receipt finalization failed; merge outcome may require reconciliation; the durable PREPARED journal must be reconciled",
    );
    wrapped.ownerMergeOutcome = "UNKNOWN";
    wrapped.ownerMergeFailureCode = "SUCCESS_RECEIPT_FINALIZATION_FAILED";
    throw wrapped;
  }
}

export function buildOwnerMergeReceipt({
  trusted,
  snapshot,
  evidence,
  inertValidation,
  merge,
  bootstrap,
}) {
  return {
    schemaVersion: 1,
    event: "MERGED",
    recordedAt: new Date().toISOString(),
    mode: bootstrap ? "owner-bootstrap-exception" : "owner-protected-main",
    trusted: {
      sha: trusted.head,
      controlDigest: trusted.controlDigest,
      reviewKind: evidence.trustedReview.kind,
      reviewArtifactSha256: evidence.trustedReview.artifact.sha256,
    },
    repository: snapshot.repository,
    pullRequest: {
      number: snapshot.prNumber,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    },
    evidence: {
      ownerEvidenceSha256: evidence.digest,
      sentryArtifactSha256: evidence.sentry.artifact.sha256,
      manualArtifacts: Object.fromEntries(
        Object.entries(evidence.manual.checkArtifacts).map(([id, artifact]) => [
          id,
          artifact.sha256,
        ]),
      ),
      runtimeSbomZipSha256: snapshot.ci.sbom.zipSha256,
      runtimeSbomSha256: snapshot.ci.sbom.sbomSha256,
    },
    hosted: {
      ciWorkflowId: snapshot.ci.workflowId,
      ciRunId: snapshot.ci.runId,
      ciRunAttempt: snapshot.ci.runAttempt,
      vercelDeploymentId: snapshot.vercel.id,
      vercelProjectId: snapshot.vercel.projectId,
      vercelTeamId: snapshot.vercel.teamId,
      vercelAggregateStatusId: snapshot.vercel.statuses.aggregate.id,
      vercelDeploymentStatusId: snapshot.vercel.statuses.deployment.id,
    },
    governanceRuleset: snapshot.ruleset,
    effectiveRules: snapshot.effectiveRules,
    candidateValidation: inertValidation,
    merge,
    branchProtection: {
      lockBranch: true,
      adminEnforcementRestored: true,
    },
  };
}
