import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_CI_JOB_NAMES,
  GITHUB_ACTIONS_APP_ID,
  OWNER_MERGE_CONTROL_FILES,
  OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS,
  REQUIRED_MANUAL_CHECK_IDS,
  buildOwnerMergePreparedIntent,
  executeOwnerMergeWithJournal,
  executeProtectedOwnerMerge,
  loadAndValidateOwnerEvidence,
  readExternalOwnerMergeFile,
  sanitizeOwnerMergeChildEnvironment,
  sanitizeOwnerMergeGitEnvironment,
  validateVercelDeploymentResponse,
  validateVercelCommitStatuses,
  validateRequiredCiCheckRuns,
  validateFrozenBrowserSemantics,
  validateOwnerMergeCollaborators,
  validateOwnerMergeEffectiveRules,
  validateOwnerMergeProtection,
  validateOwnerMergeRepositoryIdentity,
  validateOwnerMergeRuleset,
  validatePullRequestReviewState,
} from "../../../scripts/owner-merge-core.mjs";

const root = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGED = "3".repeat(40);
const TREE = "4".repeat(40);
const PREVIEW_CREATED_AT = Date.parse("2026-07-23T00:00:00.000Z");
const PREVIEW_READY_AT = Date.parse("2026-07-23T00:05:00.000Z");
const EVIDENCE_DIGEST = "7".repeat(64);
const TRUSTED_CONTROL_DIGEST = "8".repeat(64);
type MergeExecutionContext = {
  recordCriticalVerification: (
    record: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
};

function temp(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function digest(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function attachment(directory: string, name: string, content = `${name}\n`) {
  const path = join(directory, name);
  writeFileSync(path, content, { mode: 0o600 });
  return { path, sha256: digest(content) };
}

function protection(admin = true) {
  return {
    url: "https://api.github.test/protection",
    lock_branch: { enabled: true },
    enforce_admins: { enabled: admin },
    required_status_checks: { strict: true, checks: [] },
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      bypass_pull_request_allowances: {
        users: [],
        teams: [],
        apps: [],
      },
    },
    required_conversation_resolution: { enabled: true },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

function ruleset() {
  return {
    id: 70,
    name: "axis-main-production-gate",
    target: "branch",
    source_type: "Repository",
    source: "cko-md/axis",
    enforcement: "active",
    bypass_actors: [] as Array<{ actor_id: number; actor_type: string }>,
    conditions: {
      ref_name: { include: ["refs/heads/main"], exclude: [] },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: true,
          required_status_checks: [
            ...EXPECTED_CI_JOB_NAMES.map((context) => ({
              context,
              integration_id: GITHUB_ACTIONS_APP_ID,
            })),
            {
              context: "Vercel Deployments – CKO's projects",
              integration_id: 8329,
            },
          ],
        },
      },
    ],
  };
}

function effectiveRules() {
  return ruleset().rules.map((rule) => ({
    ...rule,
    ruleset_source_type: "Repository",
    ruleset_source: "cko-md/axis",
    ruleset_id: 70,
  }));
}

function rulesetStatusChecks(
  value: ReturnType<typeof ruleset>,
): Array<{ context: string; integration_id: number }> {
  const statusRule = value.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  if (!statusRule || !("parameters" in statusRule) || !statusRule.parameters) {
    throw new Error("test ruleset lacks required status checks");
  }
  const checks = statusRule.parameters.required_status_checks;
  if (!Array.isArray(checks)) {
    throw new Error("test ruleset has malformed required status checks");
  }
  return checks;
}

function normalizedRuleset() {
  return validateOwnerMergeRuleset({
    ruleset: ruleset(),
    rulesetId: 70,
    owner: "cko-md",
    name: "axis",
  });
}

function snapshot(admin = true) {
  const checks = EXPECTED_CI_JOB_NAMES.map((name, index) => ({
    id: 100 + index,
    name,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: HEAD,
    checkSuiteId: 30,
    status: "completed",
    conclusion: "success",
  }));
  return {
    repository: {
      id: 1,
      owner: "cko-md",
      name: "axis",
      fullName: "cko-md/axis",
      defaultBranch: "main",
      visibility: "public",
      private: false,
    },
    identity: "cko-md",
    principals: [],
    deployKeyCount: 0,
    baseSha: BASE,
    headSha: HEAD,
    prNumber: 300,
    ci: {
      workflowId: 10,
      runId: 20,
      runAttempt: 1,
      checkSuiteId: 30,
      jobs: EXPECTED_CI_JOB_NAMES.map((name, index) => ({
        name,
        id: 200 + index,
      })),
      checks,
      sbom: {
        artifactId: 40,
        zipSha256: "5".repeat(64),
        sbomSha256: "6".repeat(64),
        components: 1,
      },
    },
    vercel: {
      id: "dpl_test",
      projectId: "prj_test",
      teamId: "team_test",
      headSha: HEAD,
      readyState: "READY",
      url: "axis.test",
      createdAt: PREVIEW_CREATED_AT,
      readyAt: PREVIEW_READY_AT,
      statuses: {
        aggregate: { id: 50 },
        deployment: { id: 60 },
      },
    },
    protection: {
      lock_branch: { enabled: true },
      enforce_admins: { enabled: admin },
      required_status_checks: { strict: true, checks: [] },
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        bypass_pull_request_allowances: {
          users: [],
          teams: [],
          apps: [],
        },
      },
      required_conversation_resolution: { enabled: true },
      required_linear_history: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    },
    ruleset: normalizedRuleset(),
    effectiveRules: validateOwnerMergeEffectiveRules({
      rules: effectiveRules(),
      rulesetId: 70,
      owner: "cko-md",
      name: "axis",
    }),
  };
}

function verifiedSnapshot(value = snapshot()) {
  return {
    snapshot: value,
    evidenceSha256: EVIDENCE_DIGEST,
    trusted: {
      sha: HEAD,
      controlDigest: TRUSTED_CONTROL_DIGEST,
    },
  };
}

function criticalRecordSink(records: unknown[]) {
  return async (record: unknown) => {
    records.push(structuredClone(record));
  };
}

function graphReviewResult() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
          reviews: {
            nodes: [
              {
                state: "APPROVED",
                submittedAt: "2026-07-23T00:00:00Z",
                author: { login: "reviewer" },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  };
}

function collaborator(login = "cko-md") {
  return {
    login,
    role_name: login === "cko-md" ? "admin" : "read",
    permissions: {
      pull: true,
      triage: false,
      push: login === "cko-md",
      maintain: false,
      admin: login === "cko-md",
    },
  };
}

class FakeGh {
  repoPath = "/repos/cko-md/axis";
  admin = true;
  merged = false;
  failMerge = false;
  failRestore = false;
  restoreAttempts = 0;
  blockAfterAdminDisabled = false;
  unresolvedThreadAfterAdminDisabled = false;
  rulesetDriftAfterAdminDisabled = false;
  postMergeRulesetDrift = false;
  postMergeEffectiveRulesDrift = false;
  onPut?: () => void;
  calls: Array<{ method: string; endpoint: string; body?: unknown }> = [];

  get(endpoint: string) {
    this.calls.push({ method: "GET", endpoint });
    if (endpoint.endsWith("/reviews?per_page=100")) {
      return this.admin || !this.blockAfterAdminDisabled
        ? [{ user: { login: "reviewer" }, submitted_at: "2026-07-23T00:00:00Z", state: "APPROVED" }]
        : [{ user: { login: "reviewer" }, submitted_at: "2026-07-23T00:10:00Z", state: "CHANGES_REQUESTED" }];
    }
    if (endpoint.endsWith("/branches/main/protection")) {
      return protection(this.admin);
    }
    if (endpoint.endsWith("/rulesets/70")) {
      const result = ruleset();
      if (this.rulesetDriftAfterAdminDisabled && !this.admin) {
        rulesetStatusChecks(result).push({
          context: "unexpected",
          integration_id: GITHUB_ACTIONS_APP_ID,
        });
      }
      if (this.postMergeRulesetDrift && this.merged) {
        result.enforcement = "disabled";
      }
      return result;
    }
    if (endpoint.endsWith("/rules/branches/main?per_page=100")) {
      const result = effectiveRules();
      if (this.postMergeEffectiveRulesDrift && this.merged) {
        result[0]!.ruleset_source = "cko-md/unexpected";
      }
      return result;
    }
    if (endpoint.endsWith("/git/ref/heads/main")) {
      return { object: { sha: this.merged ? MERGED : BASE } };
    }
    if (endpoint.endsWith("/pulls/300")) {
      return this.merged
        ? {
            number: 300,
            merged: true,
            merge_commit_sha: MERGED,
            merged_by: { login: "cko-md" },
          }
        : {
            number: 300,
            state: "open",
            base: { ref: "main", sha: BASE },
            head: { sha: HEAD },
            mergeable: true,
          };
    }
    if (endpoint.endsWith(`/git/commits/${MERGED}`)) {
      return {
        sha: MERGED,
        tree: { sha: TREE },
        parents: [{ sha: BASE }],
      };
    }
    if (endpoint.endsWith(`/git/commits/${HEAD}`)) {
      return { sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }] };
    }
    throw new Error(`unexpected GET ${endpoint}`);
  }

  delete(endpoint: string) {
    this.calls.push({ method: "DELETE", endpoint });
    this.admin = false;
    return null;
  }

  post(endpoint: string) {
    this.calls.push({ method: "POST", endpoint });
    this.restoreAttempts += 1;
    if (this.failRestore) throw new Error("restore failed");
    this.admin = true;
    return { enabled: true };
  }

  graphql() {
    this.calls.push({ method: "GRAPHQL", endpoint: "/graphql" });
    const result = graphReviewResult();
    result.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved =
      !(this.unresolvedThreadAfterAdminDisabled && !this.admin);
    return result;
  }

  put(endpoint: string, body: unknown) {
    this.calls.push({ method: "PUT", endpoint, body });
    this.onPut?.();
    if (this.failMerge) throw new Error("merge failed");
    this.merged = true;
    return { merged: true, sha: MERGED };
  }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("owner-controlled merge root", () => {
  it("freezes the executor, schema, validator, CI semantics, and browser surfaces", () => {
    expect(OWNER_MERGE_CONTROL_FILES).toEqual(
      expect.arrayContaining([
        "scripts/owner-merge.mjs",
        "scripts/owner-merge-core.mjs",
        "scripts/owner-merge-evidence.schema.json",
        "scripts/owner-merge-ruleset.json",
        "scripts/release-validation-core.mjs",
        "scripts/state-tree-integrity.mjs",
        ".github/workflows/ci.yml",
        "playwright.config.ts",
        "tests/e2e/adversarial-rescue.spec.ts",
        "tests/e2e/authenticated.spec.ts",
        "tests/e2e/ci-smoke.spec.ts",
        "tests/e2e/operate-authenticated.spec.ts",
        "tests/e2e/workspace-authenticated.spec.ts",
      ]),
    );
    expect(() => validateFrozenBrowserSemantics(root)).not.toThrow();
    const evidenceSchema = JSON.parse(
      readFileSync(
        join(root, "scripts", "owner-merge-evidence.schema.json"),
        "utf8",
      ),
    );
    expect(
      evidenceSchema.properties.manualValidation.properties.checks.minItems,
    ).toBe(REQUIRED_MANUAL_CHECK_IDS.length);
  });

  it("accepts only out-of-tree, exact-head evidence with verified attachment hashes", () => {
    const trustedRoot = temp("axis-owner-trusted-");
    const evidenceRoot = temp("axis-owner-evidence-");
    const reviewedAt = "2026-07-23T02:00:00.000Z";
    const trustedArtifact = attachment(evidenceRoot, "trusted-review.txt");
    const sentryArtifact = attachment(evidenceRoot, "sentry-review.txt");
    const checks = REQUIRED_MANUAL_CHECK_IDS.map((id) => ({
      id,
      outcome: "pass",
      artifact: attachment(evidenceRoot, `${id}.txt`),
    }));
    const evidence = {
      schemaVersion: 1,
      repository: { id: 1, owner: "cko-md", name: "axis", rulesetId: 70 },
      pullRequest: { number: 300, baseSha: BASE, headSha: HEAD },
      vercelPreview: {
        deploymentId: "dpl_test",
        projectId: "prj_test",
        teamId: "team_test",
        headSha: HEAD,
        createdAt: PREVIEW_CREATED_AT,
        readyAt: PREVIEW_READY_AT,
      },
      trustedReview: {
        kind: "independent-bootstrap-review",
        trustedSha: HEAD,
        controlDigest: "a".repeat(64),
        reviewedBy: "independent-sol-reviewer",
        reviewedAt,
        artifact: trustedArtifact,
      },
      sentry: {
        windowStart: "2026-07-22T23:59:00.000Z",
        windowEnd: "2026-07-23T01:00:00.000Z",
        reviewedAt,
        reviewedBy: "cko-md",
        newIssueCount: 0,
        unresolvedRegressionCount: 0,
        artifact: sentryArtifact,
      },
      manualValidation: {
        completedAt: "2026-07-23T00:45:00.000Z",
        performedBy: "cko-md",
        checks,
      },
    };
    const evidencePath = join(evidenceRoot, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
    const loadEvidence = (
      options: {
        currentTime?: number;
        previewCreatedAt?: number;
        previewReadyAt?: number;
      } = {},
    ) =>
      loadAndValidateOwnerEvidence({
        evidencePath,
        trustedRoot,
        expected: {
          repositoryId: 1,
          rulesetId: 70,
          owner: "cko-md",
          name: "axis",
          prNumber: 300,
          baseSha: BASE,
          headSha: HEAD,
          trustedSha: HEAD,
          trustedControlDigest: "a".repeat(64),
          bootstrap: true,
          vercelDeploymentId: "dpl_test",
          vercelProjectId: "prj_test",
          vercelTeamId: "team_test",
        },
        previewCreatedAt: options.previewCreatedAt ?? PREVIEW_CREATED_AT,
        previewReadyAt: options.previewReadyAt ?? PREVIEW_READY_AT,
        currentTime: options.currentTime,
      });

    expect(loadEvidence()).toMatchObject({
      trustedReview: {
        kind: "independent-bootstrap-review",
        reviewedBy: "independent-sol-reviewer",
      },
    });

    evidence.manualValidation.checks = checks.filter(
      (check) => check.id !== "github-app-installation-permissions",
    );
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(loadEvidence).toThrow(
      "missing required checks: github-app-installation-permissions",
    );
    evidence.manualValidation.checks = checks;

    evidence.sentry.windowEnd = "2026-07-23T00:04:59.999Z";
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(loadEvidence).toThrow("cover the preview through Ready");
    evidence.sentry.windowEnd = "2026-07-23T01:00:00.000Z";

    evidence.manualValidation.completedAt = "2026-07-23T00:04:59.999Z";
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(loadEvidence).toThrow("complete after the exact preview became Ready");
    evidence.manualValidation.completedAt = "2026-07-23T00:45:00.000Z";

    evidence.sentry.windowEnd = "2026-07-23T00:30:00.000Z";
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(loadEvidence).toThrow("cover manual validation completion");
    evidence.sentry.windowEnd = "2026-07-23T01:00:00.000Z";
    writeFileSync(evidencePath, JSON.stringify(evidence));

    const currentTime = Date.parse("2026-07-23T02:00:00.000Z");
    const future = new Date(
      currentTime + OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS + 1,
    ).toISOString();
    evidence.trustedReview.reviewedAt = future;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() => loadEvidence({ currentTime })).toThrow(
      "trustedReview.reviewedAt is more than",
    );
    evidence.trustedReview.reviewedAt = reviewedAt;

    evidence.sentry.windowEnd = future;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() => loadEvidence({ currentTime })).toThrow(
      "sentry.windowEnd is more than",
    );
    evidence.sentry.windowEnd = "2026-07-23T01:00:00.000Z";

    evidence.sentry.windowStart = future;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() => loadEvidence({ currentTime })).toThrow(
      "sentry.windowStart is more than",
    );
    evidence.sentry.windowStart = "2026-07-22T23:59:00.000Z";

    evidence.sentry.reviewedAt = future;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() => loadEvidence({ currentTime })).toThrow(
      "sentry.reviewedAt is more than",
    );
    evidence.sentry.reviewedAt = reviewedAt;

    evidence.manualValidation.completedAt = future;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() => loadEvidence({ currentTime })).toThrow(
      "manualValidation.completedAt is more than",
    );
    evidence.manualValidation.completedAt = "2026-07-23T00:45:00.000Z";

    evidence.vercelPreview.readyAt = currentTime + OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS + 1;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() =>
      loadEvidence({
        currentTime,
        previewReadyAt: evidence.vercelPreview.readyAt,
      }),
    ).toThrow("vercelPreview.readyAt is more than");
    evidence.vercelPreview.readyAt = PREVIEW_READY_AT;

    evidence.vercelPreview.createdAt = currentTime + OWNER_MERGE_EVIDENCE_CLOCK_SKEW_MS + 1;
    evidence.vercelPreview.readyAt = evidence.vercelPreview.createdAt;
    writeFileSync(evidencePath, JSON.stringify(evidence));
    expect(() =>
      loadEvidence({
        currentTime,
        previewCreatedAt: evidence.vercelPreview.createdAt,
        previewReadyAt: evidence.vercelPreview.readyAt,
      }),
    ).toThrow("vercelPreview.createdAt is more than");
    evidence.vercelPreview.createdAt = PREVIEW_CREATED_AT;
    evidence.vercelPreview.readyAt = PREVIEW_READY_AT;
    writeFileSync(evidencePath, JSON.stringify(evidence));

    const evidenceSymlink = join(evidenceRoot, "evidence-link.json");
    symlinkSync(evidencePath, evidenceSymlink);
    expect(() =>
      loadAndValidateOwnerEvidence({
        evidencePath: evidenceSymlink,
        trustedRoot,
        expected: {
          repositoryId: 1,
          rulesetId: 70,
          owner: "cko-md",
          name: "axis",
          prNumber: 300,
          baseSha: BASE,
          headSha: HEAD,
          trustedSha: HEAD,
          trustedControlDigest: "a".repeat(64),
          bootstrap: true,
          vercelDeploymentId: "dpl_test",
          vercelProjectId: "prj_test",
          vercelTeamId: "team_test",
        },
        previewCreatedAt: PREVIEW_CREATED_AT,
        previewReadyAt: PREVIEW_READY_AT,
      }),
    ).toThrow("must directly name a regular non-symlink file");

    writeFileSync(sentryArtifact.path, "tampered\n");
    expect(loadEvidence).toThrow("sentry.artifact digest mismatch");
  });

  it("fails closed when an external evidence path is swapped after descriptor validation", () => {
    const trustedRoot = temp("axis-owner-trusted-");
    const evidenceRoot = temp("axis-owner-evidence-");
    const path = join(evidenceRoot, "evidence.json");
    const openedPath = join(evidenceRoot, "opened-evidence.json");
    writeFileSync(path, "reviewed bytes\n", { mode: 0o600 });

    expect(() =>
      readExternalOwnerMergeFile(
        path,
        "owner evidence path",
        trustedRoot,
        {
          afterValidation: () => {
            renameSync(path, openedPath);
            writeFileSync(path, "replacement bytes\n", { mode: 0o600 });
          },
        },
      ),
    ).toThrow("path changed while it was open");
  });

  it("requires Vercel's numeric Ready timestamp to follow creation", () => {
    const deployment = {
      id: "dpl_test",
      projectId: "prj_test",
      teamId: "team_test",
      gitSource: { sha: HEAD },
      target: null,
      readyState: "READY",
      createdAt: PREVIEW_CREATED_AT,
      ready: PREVIEW_READY_AT,
      url: "axis.test",
    };
    expect(
      validateVercelDeploymentResponse({
        deployment,
        deploymentId: "dpl_test",
        projectId: "prj_test",
        teamId: "team_test",
        headSha: HEAD,
      }),
    ).toMatchObject({
      createdAt: PREVIEW_CREATED_AT,
      readyAt: PREVIEW_READY_AT,
    });
    expect(() =>
      validateVercelDeploymentResponse({
        deployment: { ...deployment, ready: PREVIEW_CREATED_AT - 1 },
        deploymentId: "dpl_test",
        projectId: "prj_test",
        teamId: "team_test",
        headSha: HEAD,
      }),
    ).toThrow("createdAt/ready");
  });

  it("requires a positive CI check-suite ID and exact suite equality for every required check", () => {
    const checks = EXPECTED_CI_JOB_NAMES.map((name, index) => ({
      id: 100 + index,
      name,
      app: { id: GITHUB_ACTIONS_APP_ID },
      head_sha: HEAD,
      status: "completed",
      conclusion: "success",
      check_suite: { id: 30 },
    }));
    expect(() =>
      validateRequiredCiCheckRuns({
        checks,
        headSha: HEAD,
        checkSuiteId: 30,
      }),
    ).not.toThrow();
    expect(() =>
      validateRequiredCiCheckRuns({ checks, headSha: HEAD, checkSuiteId: 0 }),
    ).toThrow("check_suite_id must be a positive safe integer");
    expect(() =>
      validateRequiredCiCheckRuns({
        checks: checks.map((check, index) =>
          index === 0 ? { ...check, check_suite: { id: 31 } } : check,
        ),
        headSha: HEAD,
        checkSuiteId: 30,
      }),
    ).toThrow("not an exact successful app-bound check");
  });

  it("accepts the observed Vercel status shape and binds the latest statuses to the exact head and deployment", () => {
    const creator = {
      login: "vercel[bot]",
      id: 35613825,
      type: "Bot",
      avatar_url: "https://avatars.githubusercontent.com/in/8329?v=4",
    };
    const aggregateTarget =
      `https://vercel.com/cko-s-projects/~/deployments?repo=github%2Fcko-md%2Faxis` +
      `&filterBranch=codex%2Fredesign-00-governance-bootstrap&sha=${HEAD}`;
    const deploymentTarget =
      "https://vercel.com/cko-s-projects/axis-cko/C963jL17cnfuxrLaz4hTBsnyZBd4";
    const statuses = [
      {
        id: 50944252627,
        context: "Vercel Deployments – CKO's projects",
        state: "success",
        target_url: aggregateTarget,
        created_at: "2026-07-23T04:51:24Z",
        creator,
      },
      {
        id: 50944252172,
        context: "Vercel",
        state: "success",
        target_url: deploymentTarget,
        created_at: "2026-07-23T04:51:22Z",
        creator,
      },
      {
        id: 50944251597,
        context: "Vercel",
        state: "pending",
        target_url: deploymentTarget,
        created_at: "2026-07-23T04:51:21Z",
        creator,
      },
      {
        id: 50944161147,
        context: "Vercel Deployments – CKO's projects",
        state: "pending",
        target_url: aggregateTarget,
        created_at: "2026-07-23T04:48:11Z",
        creator,
      },
    ];

    expect(
      validateVercelCommitStatuses({
        statuses,
        owner: "cko-md",
        name: "axis",
        headSha: HEAD,
        headBranch: "codex/redesign-00-governance-bootstrap",
        deploymentId: "dpl_C963jL17cnfuxrLaz4hTBsnyZBd4",
      }),
    ).toEqual({
      aggregate: {
        id: 50944252627,
        context: "Vercel Deployments – CKO's projects",
        targetUrl: aggregateTarget,
      },
      deployment: {
        id: 50944252172,
        context: "Vercel",
        targetUrl: deploymentTarget,
      },
    });

    expect(() =>
      validateVercelCommitStatuses({
        statuses: [
          {
            ...statuses[1],
            id: 50944259999,
            state: "pending",
            created_at: "2026-07-23T04:52:00Z",
          },
          ...statuses,
        ],
        owner: "cko-md",
        name: "axis",
        headSha: HEAD,
        headBranch: "codex/redesign-00-governance-bootstrap",
        deploymentId: "dpl_C963jL17cnfuxrLaz4hTBsnyZBd4",
      }),
    ).toThrow("latest Vercel commit status");

    expect(() =>
      validateVercelCommitStatuses({
        statuses: statuses.map((status) =>
          status.context === "Vercel" && status.state === "success"
            ? {
                ...status,
                creator: { ...creator, id: 1 },
              }
            : status,
        ),
        owner: "cko-md",
        name: "axis",
        headSha: HEAD,
        headBranch: "codex/redesign-00-governance-bootstrap",
        deploymentId: "dpl_C963jL17cnfuxrLaz4hTBsnyZBd4",
      }),
    ).toThrow("identity-bound Vercel status");
  });

  it("keeps main locked, disables only admin enforcement, squash-merges the exact head, and restores protection", async () => {
    const gh = new FakeGh();
    const initial = snapshot();
    const criticalRecords: unknown[] = [];
    const criticalTrace: string[] = [];
    let adminOffRead = 0;
    gh.onPut = () => criticalTrace.push("PUT");
    const result = await executeProtectedOwnerMerge({
      gh,
      initialSnapshot: initial,
      reread: async () => verifiedSnapshot(initial),
      adminOffReread: async () => {
        adminOffRead += 1;
        criticalTrace.push(adminOffRead === 1 ? "A" : "B");
        return verifiedSnapshot(snapshot(false));
      },
      recordCriticalVerification: async (record: unknown) => {
        criticalTrace.push("CRITICAL_VERIFIED");
        await criticalRecordSink(criticalRecords)(record);
      },
      expectedHeadSha: HEAD,
      owner: "cko-md",
      prNumber: 300,
    });

    expect(result).toMatchObject({
      mergedSha: MERGED,
      treeSha: TREE,
      parentSha: BASE,
      method: "squash",
      mergedBy: "cko-md",
      criticalVerification: {
        ownerEvidenceSha256: EVIDENCE_DIGEST,
      },
    });
    expect(criticalRecords).toHaveLength(1);
    expect(criticalRecords[0]).toMatchObject({
      event: "CRITICAL_VERIFIED",
      ownerEvidenceSha256: EVIDENCE_DIGEST,
      mainLocked: true,
      adminEnforcement: false,
    });
    expect(criticalTrace).toEqual([
      "A",
      "CRITICAL_VERIFIED",
      "B",
      "PUT",
    ]);
    expect(gh.admin).toBe(true);
    expect(gh.calls).toContainEqual({
      method: "DELETE",
      endpoint:
        "/repos/cko-md/axis/branches/main/protection/enforce_admins",
    });
    expect(gh.calls).toContainEqual({
      method: "PUT",
      endpoint: "/repos/cko-md/axis/pulls/300/merge",
      body: { sha: HEAD, merge_method: "squash" },
    });
    expect(
      gh.calls.some(
        (call) =>
          call.endpoint.includes("protection") &&
          call.method === "PUT" &&
          JSON.stringify(call.body).includes("lock_branch"),
      ),
    ).toBe(false);
  });

  it("fails closed on GraphQL errors, partial review shapes, pagination, and malformed nodes", () => {
    const reviews = [
      {
        user: { login: "reviewer" },
        submitted_at: "2026-07-23T00:00:00Z",
        state: "APPROVED",
      },
    ];
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: graphReviewResult(),
      }),
    ).not.toThrow();

    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: {
          ...graphReviewResult(),
          errors: [{ message: "partial response" }],
        },
      }),
    ).toThrow("errors or partial data");

    const nullPullRequest = graphReviewResult();
    Object.assign(nullPullRequest.data.repository, { pullRequest: null });
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: nullPullRequest,
      }),
    ).toThrow("pull request must be an object");

    const missingThreadNodes = graphReviewResult();
    Reflect.deleteProperty(
      missingThreadNodes.data.repository.pullRequest.reviewThreads,
      "nodes",
    );
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: missingThreadNodes,
      }),
    ).toThrow("unresolved or unbounded review conversations");

    const paginatedThreads = graphReviewResult();
    paginatedThreads.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage =
      true;
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: paginatedThreads,
      }),
    ).toThrow("unresolved or unbounded review conversations");

    const unresolvedThread = graphReviewResult();
    unresolvedThread.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved =
      false;
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: unresolvedThread,
      }),
    ).toThrow("unresolved or unbounded review conversations");

    const missingReviewNodes = graphReviewResult();
    Reflect.deleteProperty(
      missingReviewNodes.data.repository.pullRequest.reviews,
      "nodes",
    );
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: missingReviewNodes,
      }),
    ).toThrow("unresolved pending or unbounded reviews");

    const paginatedReviews = graphReviewResult();
    paginatedReviews.data.repository.pullRequest.reviews.pageInfo.hasNextPage =
      true;
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: paginatedReviews,
      }),
    ).toThrow("unresolved pending or unbounded reviews");

    const missingReviewPageFlag = graphReviewResult();
    Reflect.deleteProperty(
      missingReviewPageFlag.data.repository.pullRequest.reviews.pageInfo,
      "hasNextPage",
    );
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: missingReviewPageFlag,
      }),
    ).toThrow("unresolved pending or unbounded reviews");

    const malformedReview = graphReviewResult();
    malformedReview.data.repository.pullRequest.reviews.nodes[0]!.state =
      "UNKNOWN";
    expect(() =>
      validatePullRequestReviewState({
        reviews,
        threadResult: malformedReview,
      }),
    ).toThrow("unresolved pending or unbounded reviews");

    expect(() =>
      validatePullRequestReviewState({
        reviews: [{ ...reviews[0], state: "UNKNOWN" }],
        threadResult: graphReviewResult(),
      }),
    ).toThrow("malformed review");
  });

  it("requires explicit collaborator identities and boolean permission inventories", () => {
    expect(
      validateOwnerMergeCollaborators(
        [collaborator(), collaborator("reader")],
        "cko-md",
      ),
    ).toHaveLength(2);

    const missingLogin = collaborator();
    missingLogin.login = "";
    expect(() =>
      validateOwnerMergeCollaborators([missingLogin], "cko-md"),
    ).toThrow("login must be a non-empty string");

    const missingPermission = collaborator();
    Reflect.deleteProperty(missingPermission.permissions, "admin");
    expect(() =>
      validateOwnerMergeCollaborators([missingPermission], "cko-md"),
    ).toThrow("permissions.admin must be boolean");

    const nonBooleanPermission = collaborator();
    Object.assign(nonBooleanPermission.permissions, { push: "false" });
    expect(() =>
      validateOwnerMergeCollaborators([nonBooleanPermission], "cko-md"),
    ).toThrow("permissions.push must be boolean");

    const unknownPermission = collaborator("unknown-capability");
    Object.assign(unknownPermission.permissions, { write: true });
    expect(() =>
      validateOwnerMergeCollaborators([unknownPermission], "cko-md"),
    ).toThrow("permissions contains unexpected keys: write");

    const unexpectedWriter = collaborator("unexpected-writer");
    unexpectedWriter.permissions.push = true;
    expect(() =>
      validateOwnerMergeCollaborators([unexpectedWriter], "cko-md"),
    ).toThrow("unexpected write/admin principal");
  });

  it("removes VERCEL_TOKEN from unrelated child-process environments", () => {
    expect(
      sanitizeOwnerMergeChildEnvironment({
        NODE_ENV: "test",
        PATH: "/trusted/bin",
        GH_TOKEN: "needed-by-gh",
        VERCEL_TOKEN: "must-not-leak",
      }),
    ).toEqual({
      NODE_ENV: "test",
      PATH: "/trusted/bin",
      GH_TOKEN: "needed-by-gh",
    });

    expect(
      sanitizeOwnerMergeGitEnvironment({
        NODE_ENV: "test",
        PATH: "/trusted/bin",
        GH_TOKEN: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak",
        VERCEL_TOKEN: "must-not-leak",
        GIT_CONFIG_GLOBAL: "/untrusted/config",
      }),
    ).toMatchObject({
      NODE_ENV: "test",
      PATH: "/trusted/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(
      sanitizeOwnerMergeGitEnvironment({
        NODE_ENV: "test",
        GH_TOKEN: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak",
        VERCEL_TOKEN: "must-not-leak",
      }),
    ).not.toMatchObject({
      GH_TOKEN: expect.anything(),
      GITHUB_TOKEN: expect.anything(),
      VERCEL_TOKEN: expect.anything(),
    });
  });

  it("aborts and journals NOT_MERGED when a changes-requested review arrives after the second snapshot", async () => {
    const gh = new FakeGh();
    gh.blockAfterAdminDisabled = true;
    const directory = temp("axis-owner-receipt-");
    const receiptPath = join(directory, "receipt.json");
    await expect(
      executeOwnerMergeWithJournal({
        receiptPath,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: { schemaVersion: 1, event: "PREPARED" },
        executeMerge: ({
          recordCriticalVerification,
        }: MergeExecutionContext) =>
          executeProtectedOwnerMerge({
            gh,
            initialSnapshot: snapshot(),
            reread: async () => verifiedSnapshot(),
            adminOffReread: async () => {
              throw new Error("review state changed");
            },
            recordCriticalVerification,
            expectedHeadSha: HEAD,
            owner: "cko-md",
            prNumber: 300,
          }),
        buildSuccessOutcome: () => ({ event: "MERGED" }),
      }),
    ).rejects.toThrow("records ABORTED");
    expect(gh.admin).toBe(true);
    expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(
      readFileSync(receiptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["PREPARED", "ABORTED"]);
    expect(
      JSON.parse(readFileSync(receiptPath, "utf8").trim().split("\n")[1])
        .mergeOutcome,
    ).toBe("NOT_MERGED");
  });

  it("aborts before PUT and restores enforcement when an unresolved thread arrives after the second snapshot", async () => {
    const gh = new FakeGh();
    gh.unresolvedThreadAfterAdminDisabled = true;
    await expect(
      executeProtectedOwnerMerge({
        gh,
        initialSnapshot: snapshot(),
        reread: async () => verifiedSnapshot(),
        adminOffReread: async () => {
          throw new Error("unresolved thread");
        },
        recordCriticalVerification: criticalRecordSink([]),
        expectedHeadSha: HEAD,
        owner: "cko-md",
        prNumber: 300,
      }),
    ).rejects.toMatchObject({ ownerMergeOutcome: "NOT_MERGED" });
    expect(gh.admin).toBe(true);
    expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("requires explicit empty user, team, and App PR bypass allowances", () => {
    const unlocked = protection();
    unlocked.lock_branch.enabled = false;
    expect(() => validateOwnerMergeProtection(unlocked)).toThrow(
      "main must remain locked",
    );

    const noReviewGovernance = protection();
    delete (noReviewGovernance as Partial<typeof noReviewGovernance>)
      .required_pull_request_reviews;
    expect(() => validateOwnerMergeProtection(noReviewGovernance)).toThrow(
      "require pull-request review governance",
    );

    const appBypass = protection();
    Object.assign(
      appBypass.required_pull_request_reviews.bypass_pull_request_allowances,
      { apps: [{ slug: "unexpected-app" }] },
    );
    expect(() => validateOwnerMergeProtection(appBypass)).toThrow(
      "must be explicit empty arrays",
    );

    const missingTeamArray = protection();
    Reflect.deleteProperty(
      missingTeamArray.required_pull_request_reviews
        .bypass_pull_request_allowances,
      "teams",
    );
    expect(() => validateOwnerMergeProtection(missingTeamArray)).toThrow(
      "must be explicit empty arrays",
    );

    const nonArrayAllowance = protection();
    Object.assign(
      nonArrayAllowance.required_pull_request_reviews
        .bypass_pull_request_allowances,
      { users: null },
    );
    expect(() => validateOwnerMergeProtection(nonArrayAllowance)).toThrow(
      "must be explicit empty arrays",
    );

    const unexpectedAllowanceKind = protection();
    Object.assign(
      unexpectedAllowanceKind.required_pull_request_reviews
        .bypass_pull_request_allowances,
      { repositories: [] },
    );
    expect(() =>
      validateOwnerMergeProtection(unexpectedAllowanceKind),
    ).toThrow("contains unexpected keys");
  });

  it("requires the exact public repository full name and main default branch", () => {
    const canonical = {
      id: 1,
      name: "axis",
      full_name: "cko-md/axis",
      default_branch: "main",
      visibility: "public",
      private: false,
      owner: { login: "cko-md", type: "User" },
      permissions: { admin: true },
    };
    expect(() =>
      validateOwnerMergeRepositoryIdentity({
        repo: canonical,
        repositoryId: 1,
        owner: "cko-md",
        name: "axis",
      }),
    ).not.toThrow();
    for (const drifted of [
      { ...canonical, default_branch: "trunk" },
      { ...canonical, full_name: "cko-md/other" },
      { ...canonical, visibility: "private", private: true },
    ]) {
      expect(() =>
        validateOwnerMergeRepositoryIdentity({
          repo: drifted,
          repositoryId: 1,
          owner: "cko-md",
          name: "axis",
        }),
      ).toThrow("full name/default branch/public visibility");
    }
  });

  it("requires one exact active, main-only, no-bypass ruleset with the trusted rule and App-bound check inventory", () => {
    expect(() =>
      validateOwnerMergeRuleset({
        ruleset: ruleset(),
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).not.toThrow();

    const bypass = ruleset();
    bypass.bypass_actors.push({ actor_id: 1, actor_type: "User" });
    expect(() =>
      validateOwnerMergeRuleset({ ruleset: bypass, rulesetId: 70, owner: "cko-md", name: "axis" }),
    ).toThrow("must not grant bypass actors");

    const disabled = ruleset();
    disabled.enforcement = "disabled";
    expect(() =>
      validateOwnerMergeRuleset({ ruleset: disabled, rulesetId: 70, owner: "cko-md", name: "axis" }),
    ).toThrow("enforcement is not canonical");

    const broadCondition = ruleset();
    broadCondition.conditions.ref_name.include = ["refs/heads/*"];
    expect(() =>
      validateOwnerMergeRuleset({ ruleset: broadCondition, rulesetId: 70, owner: "cko-md", name: "axis" }),
    ).toThrow("ref_name.include");

    const unexpectedRule = ruleset();
    unexpectedRule.rules.push({ type: "required_signatures" });
    expect(() =>
      validateOwnerMergeRuleset({ ruleset: unexpectedRule, rulesetId: 70, owner: "cko-md", name: "axis" }),
    ).toThrow("exactly the trusted rule set");

    const wrongApp = ruleset();
    const firstCheck = rulesetStatusChecks(wrongApp)[0];
    if (!firstCheck) throw new Error("test ruleset lacks its first required check");
    firstCheck.integration_id = 1;
    expect(() =>
      validateOwnerMergeRuleset({ ruleset: wrongApp, rulesetId: 70, owner: "cko-md", name: "axis" }),
    ).toThrow("exact trusted App-bound set");

    const missingCheck = ruleset();
    rulesetStatusChecks(missingCheck).pop();
    expect(() =>
      validateOwnerMergeRuleset({ ruleset: missingCheck, rulesetId: 70, owner: "cko-md", name: "axis" }),
    ).toThrow("unexpected required status-check count");
  });

  it("keeps the committed ruleset creation payload aligned with the exact validator contract", () => {
    const payload = JSON.parse(
      readFileSync(
        join(root, "scripts", "owner-merge-ruleset.json"),
        "utf8",
      ),
    );
    const configured = ruleset();
    expect(payload).toEqual({
      name: configured.name,
      target: configured.target,
      enforcement: configured.enforcement,
      bypass_actors: configured.bypass_actors,
      conditions: configured.conditions,
      rules: configured.rules,
    });
    expect(payload.name).toBe("axis-main-production-gate");
    expect(payload.rules.map((rule: { type: string }) => rule.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "required_linear_history",
      "pull_request",
      "required_status_checks",
    ]);
    expect(
      payload.rules.find(
        (rule: { type: string }) => rule.type === "pull_request",
      ).parameters.dismiss_stale_reviews_on_push,
    ).toBe(true);
  });

  it("requires the effective main rules to be exactly the five pinned-source rules with no pagination ambiguity", () => {
    expect(() =>
      validateOwnerMergeEffectiveRules({
        rules: effectiveRules(),
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).not.toThrow();

    const missing = effectiveRules();
    missing.pop();
    expect(() =>
      validateOwnerMergeEffectiveRules({
        rules: missing,
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).toThrow("exactly the trusted five-rule set");

    const wrongSource = effectiveRules();
    wrongSource[0]!.ruleset_source = "cko-md/other";
    expect(() =>
      validateOwnerMergeEffectiveRules({
        rules: wrongSource,
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).toThrow("exact pinned repository ruleset");

    const duplicate = effectiveRules();
    duplicate[1] = structuredClone(duplicate[0]!);
    expect(() =>
      validateOwnerMergeEffectiveRules({
        rules: duplicate,
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).toThrow("unexpected or duplicate rule");

    const wrongCheck = effectiveRules();
    const statusRule = wrongCheck.find(
      (rule) => rule.type === "required_status_checks",
    );
    if (!statusRule?.parameters?.required_status_checks) {
      throw new Error("test effective rules lack status checks");
    }
    statusRule.parameters.required_status_checks[0]!.integration_id = 1;
    expect(() =>
      validateOwnerMergeEffectiveRules({
        rules: wrongCheck,
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).toThrow("exact trusted App-bound set");

    expect(() =>
      validateOwnerMergeEffectiveRules({
        rules: Array.from({ length: 100 }, () => effectiveRules()[0]),
        rulesetId: 70,
        owner: "cko-md",
        name: "axis",
      }),
    ).toThrow("pagination is ambiguous");
  });

  it.each<
    [
      string,
      (verification: ReturnType<typeof verifiedSnapshot>) => void,
    ]
  >([
    [
      "CI run",
      (verification) => {
        verification.snapshot.ci.runId += 1;
      },
    ],
    [
      "check run",
      (verification) => {
        verification.snapshot.ci.checks[0]!.id += 1;
      },
    ],
    [
      "Vercel status",
      (verification) => {
        verification.snapshot.vercel.statuses.aggregate.id += 1;
      },
    ],
    [
      "Vercel API deployment",
      (verification) => {
        verification.snapshot.vercel.url = "drifted.axis.test";
      },
    ],
    [
      "external evidence",
      (verification) => {
        verification.evidenceSha256 = "9".repeat(64);
      },
    ],
    [
      "trusted control root",
      (verification) => {
        verification.trusted.controlDigest = "9".repeat(64);
      },
    ],
    [
      "effective rules",
      (verification) => {
        verification.snapshot.effectiveRules.source = "cko-md/other";
      },
    ],
    [
      "repository default branch",
      (verification) => {
        verification.snapshot.repository.defaultBranch = "trunk";
      },
    ],
  ])(
    "restores admin enforcement and sends no PUT when %s drifts after CRITICAL_VERIFIED",
    async (_label, mutate) => {
      const gh = new FakeGh();
      const records: unknown[] = [];
      let adminOffRead = 0;
      await expect(
        executeProtectedOwnerMerge({
          gh,
          initialSnapshot: snapshot(),
          reread: async () => verifiedSnapshot(),
          adminOffReread: async () => {
            adminOffRead += 1;
            const verification = verifiedSnapshot(snapshot(false));
            if (adminOffRead === 2) mutate(verification);
            return verification;
          },
          recordCriticalVerification: criticalRecordSink(records),
          expectedHeadSha: HEAD,
          owner: "cko-md",
          prNumber: 300,
        }),
      ).rejects.toMatchObject({ ownerMergeOutcome: "NOT_MERGED" });
      expect(records).toHaveLength(1);
      expect(gh.admin).toBe(true);
      expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
    },
  );

  it("durably records the verified admin-off snapshot before a post-record drift abort", async () => {
    const gh = new FakeGh();
    const directory = temp("axis-owner-receipt-");
    const receiptPath = join(directory, "receipt.jsonl");
    let adminOffRead = 0;
    await expect(
      executeOwnerMergeWithJournal({
        receiptPath,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: { schemaVersion: 1, event: "PREPARED" },
        executeMerge: ({
          recordCriticalVerification,
        }: MergeExecutionContext) =>
          executeProtectedOwnerMerge({
            gh,
            initialSnapshot: snapshot(),
            reread: async () => verifiedSnapshot(),
            adminOffReread: async () => {
              adminOffRead += 1;
              const verification = verifiedSnapshot(snapshot(false));
              if (adminOffRead === 2) {
                verification.snapshot.ci.checks[0]!.id += 1;
              }
              return verification;
            },
            recordCriticalVerification,
            expectedHeadSha: HEAD,
            owner: "cko-md",
            prNumber: 300,
          }),
        buildSuccessOutcome: () => ({ event: "MERGED" }),
      }),
    ).rejects.toThrow("records ABORTED");
    const records = readFileSync(receiptPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual([
      "PREPARED",
      "CRITICAL_VERIFIED",
      "ABORTED",
    ]);
    expect(records[1]).toMatchObject({
      ownerEvidenceSha256: EVIDENCE_DIGEST,
      mainLocked: true,
      adminEnforcement: false,
    });
    expect(gh.admin).toBe(true);
    expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("restores admin enforcement and sends no PUT when the critical journal callback fails", async () => {
    const gh = new FakeGh();
    await expect(
      executeProtectedOwnerMerge({
        gh,
        initialSnapshot: snapshot(),
        reread: async () => verifiedSnapshot(),
        adminOffReread: async () => verifiedSnapshot(snapshot(false)),
        recordCriticalVerification: async () => {
          throw new Error("simulated critical fsync failure");
        },
        expectedHeadSha: HEAD,
        owner: "cko-md",
        prNumber: 300,
      }),
    ).rejects.toMatchObject({ ownerMergeOutcome: "NOT_MERGED" });
    expect(gh.admin).toBe(true);
    expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("preserves ADMIN_ENFORCEMENT_RESTORE_FAILED/UNKNOWN when the critical journal write and restoration both fail", async () => {
    const gh = new FakeGh();
    gh.failRestore = true;
    const directory = temp("axis-owner-receipt-");
    const receiptPath = join(directory, "receipt.jsonl");

    await expect(
      executeOwnerMergeWithJournal({
        receiptPath,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: { schemaVersion: 1, event: "PREPARED" },
        appendCriticalVerification: () => {
          throw new Error("simulated critical fsync failure");
        },
        executeMerge: ({
          recordCriticalVerification,
        }: MergeExecutionContext) =>
          executeProtectedOwnerMerge({
            gh,
            initialSnapshot: snapshot(),
            reread: async () => verifiedSnapshot(),
            adminOffReread: async () => verifiedSnapshot(snapshot(false)),
            recordCriticalVerification,
            expectedHeadSha: HEAD,
            owner: "cko-md",
            prNumber: 300,
            restoreOptions: {
              retries: 1,
              delayImpl: async () => undefined,
            },
          }),
        buildSuccessOutcome: () => ({ event: "MERGED" }),
      }),
    ).rejects.toMatchObject({
      ownerMergeOutcome: "UNKNOWN",
      ownerMergeFailureCode: "ADMIN_ENFORCEMENT_RESTORE_FAILED",
    });

    expect(gh.admin).toBe(false);
    expect(gh.restoreAttempts).toBe(1);
    expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(
      readFileSync(receiptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["PREPARED"]);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o400);
  });

  it("retries admin restoration through exhaustion and preserves UNKNOWN classification", async () => {
    const gh = new FakeGh();
    gh.failRestore = true;
    const retryDelays: number[] = [];

    await expect(
      executeProtectedOwnerMerge({
        gh,
        initialSnapshot: snapshot(),
        reread: async () => verifiedSnapshot(),
        adminOffReread: async () => verifiedSnapshot(snapshot(false)),
        recordCriticalVerification: criticalRecordSink([]),
        expectedHeadSha: HEAD,
        owner: "cko-md",
        prNumber: 300,
        restoreOptions: {
          retries: 3,
          delayImpl: async (milliseconds: number) => {
            retryDelays.push(milliseconds);
          },
        },
      }),
    ).rejects.toMatchObject({
      ownerMergeOutcome: "UNKNOWN",
      ownerMergeFailureCode: "ADMIN_ENFORCEMENT_RESTORE_FAILED",
    });

    expect(gh.merged).toBe(true);
    expect(gh.admin).toBe(false);
    expect(gh.restoreAttempts).toBe(3);
    expect(retryDelays).toEqual([250, 500]);
  });

  it("preserves the critical restoration classification when outcome journal finalization also fails", async () => {
    const gh = new FakeGh();
    gh.failRestore = true;
    const directory = temp("axis-owner-receipt-");
    const receiptPath = join(directory, "receipt.jsonl");

    await expect(
      executeOwnerMergeWithJournal({
        receiptPath,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: { schemaVersion: 1, event: "PREPARED" },
        executeMerge: ({
          recordCriticalVerification,
        }: MergeExecutionContext) =>
          executeProtectedOwnerMerge({
            gh,
            initialSnapshot: snapshot(),
            reread: async () => verifiedSnapshot(),
            adminOffReread: async () => verifiedSnapshot(snapshot(false)),
            recordCriticalVerification,
            expectedHeadSha: HEAD,
            owner: "cko-md",
            prNumber: 300,
            restoreOptions: {
              retries: 1,
              delayImpl: async () => undefined,
            },
          }),
        buildSuccessOutcome: () => ({ event: "MERGED" }),
        finalizeJournal: () => {
          throw new Error("simulated outcome fsync failure");
        },
      }),
    ).rejects.toMatchObject({
      ownerMergeOutcome: "UNKNOWN",
      ownerMergeFailureCode: "ADMIN_ENFORCEMENT_RESTORE_FAILED",
      message: expect.stringContaining(
        "admin-enforcement restoration and receipt finalization both failed",
      ),
    });

    expect(gh.merged).toBe(true);
    expect(gh.admin).toBe(false);
    expect(
      readFileSync(receiptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["PREPARED", "CRITICAL_VERIFIED"]);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o400);
  });

  it.each(["direct ruleset", "effective rules"] as const)(
    "journals reconciliation when post-merge %s drift is detected",
    async (driftKind) => {
      const gh = new FakeGh();
      if (driftKind === "direct ruleset") {
        gh.postMergeRulesetDrift = true;
      } else {
        gh.postMergeEffectiveRulesDrift = true;
      }
      const directory = temp("axis-owner-receipt-");
      const receiptPath = join(directory, "receipt.jsonl");

      await expect(
        executeOwnerMergeWithJournal({
          receiptPath,
          trustedRoot: temp("axis-owner-trusted-"),
          preparedIntent: { schemaVersion: 1, event: "PREPARED" },
          executeMerge: ({
            recordCriticalVerification,
          }: MergeExecutionContext) =>
            executeProtectedOwnerMerge({
              gh,
              initialSnapshot: snapshot(),
              reread: async () => verifiedSnapshot(),
              adminOffReread: async () => verifiedSnapshot(snapshot(false)),
              recordCriticalVerification,
              expectedHeadSha: HEAD,
              owner: "cko-md",
              prNumber: 300,
            }),
          buildSuccessOutcome: () => ({ event: "MERGED" }),
        }),
      ).rejects.toThrow("records RECONCILIATION_REQUIRED");

      expect(gh.merged).toBe(true);
      expect(gh.admin).toBe(true);
      const records = readFileSync(receiptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.event)).toEqual([
        "PREPARED",
        "CRITICAL_VERIFIED",
        "RECONCILIATION_REQUIRED",
      ]);
      expect(records.at(-1)).toMatchObject({
        mergeOutcome: "UNKNOWN",
        failureCode: "POST_MERGE_VERIFICATION_FAILED",
      });
    },
  );

  it("restores admin enforcement and sends no merge PUT when the ruleset drifts after the second snapshot", async () => {
    const gh = new FakeGh();
    gh.rulesetDriftAfterAdminDisabled = true;
    await expect(
      executeProtectedOwnerMerge({
        gh,
        initialSnapshot: snapshot(),
        reread: async () => verifiedSnapshot(),
        adminOffReread: async () => {
          const drifted = snapshot(false);
          drifted.ruleset.enforcement = "disabled";
          return verifiedSnapshot(drifted);
        },
        recordCriticalVerification: criticalRecordSink([]),
        expectedHeadSha: HEAD,
        owner: "cko-md",
        prNumber: 300,
      }),
    ).rejects.toMatchObject({ ownerMergeOutcome: "NOT_MERGED" });
    expect(gh.admin).toBe(true);
    expect(gh.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("restores admin enforcement when the exact merge API call fails", async () => {
    const gh = new FakeGh();
    gh.failMerge = true;
    await expect(
      executeProtectedOwnerMerge({
        gh,
        initialSnapshot: snapshot(),
        reread: async () => verifiedSnapshot(),
        adminOffReread: async () => verifiedSnapshot(snapshot(false)),
        recordCriticalVerification: criticalRecordSink([]),
        expectedHeadSha: HEAD,
        owner: "cko-md",
        prNumber: 300,
      }),
    ).rejects.toThrow("outcome requires reconciliation");
    expect(gh.admin).toBe(true);
    expect(gh.calls).toContainEqual({
      method: "POST",
      endpoint:
        "/repos/cko-md/axis/branches/main/protection/enforce_admins",
    });
  });

  it("durably writes PREPARED before merge and finalizes a read-only journal", async () => {
    const directory = temp("axis-owner-receipt-");
    const path = join(directory, "receipt.json");
    let sawPrepared = false;
    const { written } = await executeOwnerMergeWithJournal({
      receiptPath: path,
      trustedRoot: temp("axis-owner-trusted-"),
      preparedIntent: {
        schemaVersion: 1,
        event: "PREPARED",
        repository: { id: 1, owner: "cko-md", name: "axis", rulesetId: 70 },
      },
      executeMerge: async ({
        recordCriticalVerification,
      }: MergeExecutionContext) => {
        const records = readFileSync(path, "utf8").trim().split("\n");
        sawPrepared = JSON.parse(records[0]).event === "PREPARED";
        await recordCriticalVerification({
          schemaVersion: 1,
          event: "CRITICAL_VERIFIED",
        });
        return { mergedSha: MERGED };
      },
      buildSuccessOutcome: (merge: { mergedSha: string }) => ({
        schemaVersion: 1,
        event: "MERGED",
        merge,
      }),
    });
    expect(sawPrepared).toBe(true);
    expect(written.sha256).toBe(digest(readFileSync(path)));
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["PREPARED", "CRITICAL_VERIFIED", "MERGED"]);
    await expect(
      executeOwnerMergeWithJournal({
        receiptPath: path,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: { schemaVersion: 1, event: "PREPARED" },
        executeMerge: async () => ({ mergedSha: MERGED }),
        buildSuccessOutcome: () => ({ event: "MERGED" }),
      }),
    ).rejects.toThrow();
  });

  it("binds PREPARED to the trusted snapshot, evidence, candidate, and exact approval without storing the phrase", () => {
    const intent = buildOwnerMergePreparedIntent({
      trusted: { head: HEAD, controlDigest: "a".repeat(64) },
      snapshot: snapshot(),
      evidence: {
        digest: "b".repeat(64),
        trustedReview: {
          kind: "independent-bootstrap-review",
          artifact: { sha256: "c".repeat(64) },
        },
        sentry: { artifact: { sha256: "d".repeat(64) } },
        manual: {
          checkArtifacts: {
            "vercel-preview": { sha256: "e".repeat(64) },
          },
        },
      },
      inertValidation: { baseSha: BASE, headSha: HEAD, passed: true },
      bootstrap: true,
      approvalPhrase: "I APPROVE THE EXACT AXIS OWNER MERGE",
    });
    expect(intent).toMatchObject({
      event: "PREPARED",
      trusted: { sha: HEAD, controlDigest: "a".repeat(64) },
      evidence: { ownerEvidenceSha256: "b".repeat(64) },
      candidateValidation: {
        baseSha: BASE,
        headSha: HEAD,
        passed: true,
      },
      hosted: {
        vercelCreatedAt: PREVIEW_CREATED_AT,
        vercelReadyAt: PREVIEW_READY_AT,
      },
      governanceRuleset: {
        id: 70,
        enforcement: "active",
        conditions: { refName: { include: ["refs/heads/main"], exclude: [] } },
      },
      effectiveRules: {
        rulesetId: 70,
        sourceType: "Repository",
        source: "cko-md/axis",
      },
    });
    expect(intent.remoteSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(intent)).not.toContain(
      "I APPROVE THE EXACT AXIS OWNER MERGE",
    );
  });

  it("retains durable PREPARED evidence when finalization fails after merge", async () => {
    const directory = temp("axis-owner-receipt-");
    const path = join(directory, "receipt.json");
    let mergeRan = false;
    await expect(
      executeOwnerMergeWithJournal({
        receiptPath: path,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: {
          schemaVersion: 1,
          event: "PREPARED",
          evidence: { ownerEvidenceSha256: "a".repeat(64) },
        },
        executeMerge: async ({
          recordCriticalVerification,
        }: MergeExecutionContext) => {
          mergeRan = true;
          await recordCriticalVerification({
            schemaVersion: 1,
            event: "CRITICAL_VERIFIED",
          });
          return { mergedSha: MERGED };
        },
        buildSuccessOutcome: () => ({ event: "MERGED" }),
        finalizeJournal: () => {
          throw new Error("simulated final write failure");
        },
      }),
    ).rejects.toThrow(
      "merge outcome may require reconciliation; the durable PREPARED journal",
    );
    expect(mergeRan).toBe(true);
    expect(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["PREPARED", "CRITICAL_VERIFIED"]);
    expect(statSync(path).mode & 0o777).toBe(0o400);
  });

  it("records a secret-free ABORTED outcome for a known pre-merge failure", async () => {
    const directory = temp("axis-owner-receipt-");
    const path = join(directory, "receipt.json");
    const unsafe = Object.assign(
      new Error("gh response included token=never-record-this"),
      {
        ownerMergeOutcome: "NOT_MERGED",
        ownerMergeFailureCode: "PRE_MERGE_CHECK_FAILED",
      },
    );
    await expect(
      executeOwnerMergeWithJournal({
        receiptPath: path,
        trustedRoot: temp("axis-owner-trusted-"),
        preparedIntent: { schemaVersion: 1, event: "PREPARED" },
        executeMerge: async () => {
          throw unsafe;
        },
        buildSuccessOutcome: () => ({ event: "MERGED" }),
      }),
    ).rejects.toThrow("records ABORTED");
    const content = readFileSync(path, "utf8");
    expect(content).not.toContain("never-record-this");
    expect(
      content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["PREPARED", "ABORTED"]);
    expect(statSync(path).mode & 0o777).toBe(0o400);
  });
});
