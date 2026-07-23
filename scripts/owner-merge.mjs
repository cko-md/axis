#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GhApi,
  OWNER_MERGE_APPROVAL_PHRASE,
  buildOwnerMergePreparedIntent,
  buildOwnerMergeReceipt,
  collectOwnerMergeSnapshot,
  computeOwnerMergeControlDigest,
  executeOwnerMergeWithJournal,
  executeProtectedOwnerMerge,
  loadAndValidateOwnerEvidence,
  validateCandidateAsInertData,
  validateExternalNewReceiptPath,
  verifyTrustedExecutionRoot,
} from "./owner-merge-core.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function usage() {
  return `Usage:
  node scripts/owner-merge.mjs --print-control-digest --trusted-sha=<sha>
  node scripts/owner-merge.mjs [--execute --approval-phrase="${OWNER_MERGE_APPROVAL_PHRASE}"] \\
    --repository-id=<numeric-id> --owner=<login> --name=<repo> --pr=<number> \\
    --ruleset-id=<numeric-id> \\
    --head-sha=<sha> --trusted-sha=<sha> --trusted-control-digest=<sha256> \\
    --ci-workflow-id=<id> --ci-run-id=<id> --ci-run-attempt=<n> \\
    --vercel-deployment-id=<id> --vercel-project-id=<id> --vercel-team-id=<id> \\
    --evidence=</absolute/evidence.json> [--bootstrap] [--receipt=</absolute/receipt.jsonl>]

Dry-run is the default. Mutation requires both --execute and the exact approval phrase.
The executor refuses GitHub Actions/Vercel execution and never unlocks main.`;
}

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (const argument of argv) {
    if (argument === "--execute" || argument === "--bootstrap" || argument === "--print-control-digest") {
      if (flags.has(argument)) throw new Error(`duplicate flag ${argument}`);
      flags.add(argument);
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.*)$/);
    if (!match || values.has(match[1])) throw new Error(`invalid or duplicate argument ${argument}`);
    values.set(match[1], match[2]);
  }
  return { flags, values };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function positiveInteger(values, key) {
  const value = Number(required(values, key));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive safe integer`);
  }
  return value;
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("--print-control-digest")) {
    if (flags.size !== 1 || values.size !== 1 || !values.has("trusted-sha")) {
      throw new Error("--print-control-digest accepts only --trusted-sha");
    }
    const trustedSha = required(values, "trusted-sha");
    const digest = computeOwnerMergeControlDigest(root);
    verifyTrustedExecutionRoot({
      trustedRoot: root,
      trustedSha,
      trustedControlDigest: digest,
    });
    process.stdout.write(`${digest}\n`);
    return;
  }

  const execute = flags.has("--execute");
  const bootstrap = flags.has("--bootstrap");
  const approval = values.get("approval-phrase");
  if (execute && approval !== OWNER_MERGE_APPROVAL_PHRASE) {
    throw new Error("mutation requires the exact documented --approval-phrase");
  }
  if (!execute && approval !== undefined) {
    throw new Error("--approval-phrase is accepted only with --execute");
  }
  const allowedValues = new Set([
    "repository-id",
    "ruleset-id",
    "owner",
    "name",
    "pr",
    "head-sha",
    "trusted-sha",
    "trusted-control-digest",
    "ci-workflow-id",
    "ci-run-id",
    "ci-run-attempt",
    "vercel-deployment-id",
    "vercel-project-id",
    "vercel-team-id",
    "evidence",
    "receipt",
    "approval-phrase",
  ]);
  for (const key of values.keys()) {
    if (!allowedValues.has(key)) throw new Error(`unsupported argument --${key}`);
  }

  const repositoryId = positiveInteger(values, "repository-id");
  const rulesetId = positiveInteger(values, "ruleset-id");
  const owner = required(values, "owner");
  const name = required(values, "name");
  const prNumber = positiveInteger(values, "pr");
  const expectedHeadSha = required(values, "head-sha");
  const trustedSha = required(values, "trusted-sha");
  const trustedControlDigest = required(values, "trusted-control-digest");
  const ciWorkflowId = positiveInteger(values, "ci-workflow-id");
  const ciRunId = positiveInteger(values, "ci-run-id");
  const ciRunAttempt = positiveInteger(values, "ci-run-attempt");
  const vercelDeploymentId = required(values, "vercel-deployment-id");
  const vercelProjectId = required(values, "vercel-project-id");
  const vercelTeamId = required(values, "vercel-team-id");
  const evidencePath = required(values, "evidence");
  const receiptPath = values.get("receipt");
  if (!isAbsolute(evidencePath)) throw new Error("--evidence must be absolute");
  if (execute && (!receiptPath || !isAbsolute(receiptPath))) {
    throw new Error("mutation requires an absolute, nonexistent --receipt path");
  }
  if (!execute && receiptPath !== undefined) {
    throw new Error("--receipt is accepted only with --execute");
  }
  const validatedReceiptPath = execute
    ? validateExternalNewReceiptPath(receiptPath, root)
    : undefined;

  const trusted = verifyTrustedExecutionRoot({
    trustedRoot: root,
    trustedSha,
    trustedControlDigest,
  });
  const gh = new GhApi({ owner, name });
  const snapshotArgs = {
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
    vercelToken: process.env.VERCEL_TOKEN,
  };
  const snapshot = await collectOwnerMergeSnapshot(snapshotArgs);
  if (
    (bootstrap && trustedSha !== expectedHeadSha) ||
    (!bootstrap && trustedSha !== snapshot.baseSha)
  ) {
    throw new Error(
      bootstrap
        ? "bootstrap mode requires the trusted SHA to equal the exact PR head"
        : "normal mode requires the trusted SHA to equal exact current main",
    );
  }
  const evidence = loadAndValidateOwnerEvidence({
    evidencePath,
    trustedRoot: root,
    expected: {
      repositoryId,
      rulesetId,
      owner,
      name,
      prNumber,
      baseSha: snapshot.baseSha,
      headSha: expectedHeadSha,
      trustedSha,
      trustedControlDigest,
      bootstrap,
      vercelDeploymentId,
      vercelProjectId,
      vercelTeamId,
    },
    previewCreatedAt: snapshot.vercel.createdAt,
    previewReadyAt: snapshot.vercel.readyAt,
  });
  const inertValidation = validateCandidateAsInertData({
    trustedRoot: root,
    owner,
    name,
    baseSha: snapshot.baseSha,
    headSha: expectedHeadSha,
    bootstrap,
  });

  if (!execute) {
    process.stdout.write(
      `${JSON.stringify(
        {
          result: "DRY_RUN_PASS",
          repository: snapshot.repository,
          pr: {
            number: prNumber,
            baseSha: snapshot.baseSha,
            headSha: snapshot.headSha,
          },
          trusted: {
            sha: trusted.head,
            controlDigest: trusted.controlDigest,
            bootstrap,
          },
          ci: snapshot.ci,
          vercel: snapshot.vercel,
          ruleset: snapshot.ruleset,
          effectiveRules: snapshot.effectiveRules,
          evidenceSha256: evidence.digest,
          candidateValidation: inertValidation,
          mutationPerformed: false,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const preparedIntent = buildOwnerMergePreparedIntent({
    trusted,
    snapshot,
    evidence,
    inertValidation,
    bootstrap,
    approvalPhrase: approval,
  });
  const collectVerifiedSnapshot = async (expectedAdminState) => {
    const latest = await collectOwnerMergeSnapshot({
      ...snapshotArgs,
      expectedAdminState,
    });
    const latestTrusted = verifyTrustedExecutionRoot({
      trustedRoot: root,
      trustedSha,
      trustedControlDigest,
    });
    const latestEvidence = loadAndValidateOwnerEvidence({
      evidencePath,
      trustedRoot: root,
      expected: {
        repositoryId,
        rulesetId,
        owner,
        name,
        prNumber,
        baseSha: latest.baseSha,
        headSha: expectedHeadSha,
        trustedSha,
        trustedControlDigest,
        bootstrap,
        vercelDeploymentId,
        vercelProjectId,
        vercelTeamId,
      },
      previewCreatedAt: latest.vercel.createdAt,
      previewReadyAt: latest.vercel.readyAt,
    });
    if (latestEvidence.digest !== evidence.digest) {
      throw new Error(
        "external owner evidence changed before the merge critical section",
      );
    }
    return {
      snapshot: latest,
      evidenceSha256: latestEvidence.digest,
      trusted: {
        sha: latestTrusted.head,
        controlDigest: latestTrusted.controlDigest,
      },
    };
  };
  const { merge, written } = await executeOwnerMergeWithJournal({
    receiptPath: validatedReceiptPath,
    trustedRoot: root,
    preparedIntent,
    executeMerge: ({ recordCriticalVerification }) =>
      executeProtectedOwnerMerge({
        gh,
        initialSnapshot: snapshot,
        reread: () => collectVerifiedSnapshot(true),
        adminOffReread: () => collectVerifiedSnapshot(false),
        recordCriticalVerification,
        expectedHeadSha,
        owner,
        prNumber,
      }),
    buildSuccessOutcome: (completedMerge) =>
      buildOwnerMergeReceipt({
        trusted,
        snapshot,
        evidence,
        inertValidation,
        merge: completedMerge,
        bootstrap,
      }),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "MERGED",
        mergedSha: merge.mergedSha,
        receipt: written,
        mainLocked: true,
        adminEnforcementRestored: true,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `owner merge failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
});
