import { resolve } from "node:path";
import { validateCandidateReleaseGovernance } from "./release-validation-core.mjs";

const EXPECTED_BRANCH_ENV = "AXIS_EXPECTED_PR_HEAD_REF";
const SAFE_BRANCH = /^(?!.*(?:\.\.|\/\/))[A-Za-z0-9][A-Za-z0-9._/-]{0,254}(?<![./])$/;

function expectedBranchFromEnvironment() {
  const branch = process.env[EXPECTED_BRANCH_ENV];
  if (typeof branch !== "string" || !SAFE_BRANCH.test(branch)) {
    throw new Error(`${EXPECTED_BRANCH_ENV} must contain a nonempty safe pull-request head branch`);
  }
  return branch;
}

function parseArgs(argv) {
  const values = new Map();
  for (const argument of argv) {
    const match = argument.match(/^--(base|candidate)=(.+)$/);
    if (!match || values.has(match[1])) {
      throw new Error(
        "usage: validate-release-candidate.mjs --base=<trusted-base-tree> --candidate=<untrusted-candidate-tree>",
      );
    }
    values.set(match[1], match[2]);
  }
  if (!values.has("base") || !values.has("candidate") || values.size !== 2) {
    throw new Error(
      "usage: validate-release-candidate.mjs --base=<trusted-base-tree> --candidate=<untrusted-candidate-tree>",
    );
  }
  return {
    baseRoot: resolve(values.get("base")),
    candidateRoot: resolve(values.get("candidate")),
  };
}

try {
  const errors = validateCandidateReleaseGovernance({
    ...parseArgs(process.argv.slice(2)),
    expectedBranch: expectedBranchFromEnvironment(),
  });
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`release governance failed: ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Release governance passed: candidate migrations are append-only, workflows are structurally safe, and Vercel Git integration remains the sole production deploy owner.",
    );
  }
} catch (error) {
  console.error(
    `release governance failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
