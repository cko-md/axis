#!/usr/bin/env node
/**
 * Vercel ignoreCommand contract:
 *   exit 0     -> skip this deployment
 *   non-zero   -> continue and build
 *
 * Previews always build. Production fails closed unless the canonical state was
 * derived from a tree whose source content already matched main. This creates a
 * deliberate two-merge release cadence:
 *
 *   1. merge source/policy change -> production deployment is skipped
 *   2. derive state from updated main and merge only generated state artifacts
 *      -> production build proceeds
 *
 * The comparison uses only the checked-out git tree. It requires no API token,
 * ancestor lookup, or history fetch and therefore works in Vercel's
 * depth-limited shallow clone. Its checksum is consistency evidence, not an
 * attestation. Authorization comes from the immutable base-controlled
 * `release-governance` check plus the protected hosted checks before merge.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  gitTreeContentHash,
  stateEvidenceFingerprint,
} from "./state-tree-integrity.mjs";

const GENERATED_STATE = ".claude/axis-redesign/GENERATED_STATE.json";
const BUILD_SENTINEL = "AXIS_VERCEL_DECISION=BUILD";

function continueBuild(message) {
  process.stdout.write(`AXIS Vercel gate: build (${message}).\n`);
  process.stdout.write(`${BUILD_SENTINEL}\n`);
  // The shell wrapper maps only this dedicated status plus the final sentinel
  // to Vercel's non-zero "build" result. A normal Node crash exits differently
  // and therefore becomes a fail-closed skip.
  process.exitCode = 73;
}

function skipProduction(message) {
  process.stdout.write(`AXIS Vercel gate: skip production (${message}).\n`);
  process.exitCode = 0;
}

function localGatesPass(gates, currentTree) {
  return (
    gates?.measured === true
    && gates.sourceContentTreeHash === currentTree
    && gates.typecheck?.passed === true
    && gates.lint?.passed === true
    && gates.build?.passed === true
    && Number.isInteger(gates.tests?.total)
    && gates.tests.total > 0
    && gates.tests.passed === gates.tests.total
    && Number.isFinite(gates.bundleKb?.used)
    && Number.isFinite(gates.bundleKb?.budget)
    && gates.bundleKb.used <= gates.bundleKb.budget
    && Number.isFinite(gates.routeIsolatedBundleKb?.used)
    && Number.isFinite(gates.routeIsolatedBundleKb?.budget)
    && gates.routeIsolatedBundleKb.used <= gates.routeIsolatedBundleKb.budget
  );
}

if (
  process.env.VERCEL_ENV === "preview"
  || process.env.VERCEL_ENV === "development"
) {
  continueBuild("preview/development deployments are never state-suppressed");
} else if (process.env.VERCEL_ENV === "production") {
  try {
    const snapshot = JSON.parse(
      readFileSync(path.join(process.cwd(), GENERATED_STATE), "utf8"),
    );
    const current = gitTreeContentHash({ cwd: process.cwd(), ref: "HEAD" });
    const recorded = snapshot?.git?.contentTreeHash;
    const sourceMain = snapshot?.git?.sourceMainContentTreeHash;
    const provenance = {
      branch: snapshot?.git?.branch,
      head: snapshot?.git?.head,
      mainHead: snapshot?.git?.mainHead,
      workingTreeClean: snapshot?.git?.workingTreeClean,
      aheadOfMain: Array.isArray(snapshot?.git?.aheadOfMain)
        ? snapshot.git.aheadOfMain
        : [],
    };

    if (
      typeof recorded !== "string"
      || typeof sourceMain !== "string"
      || recorded.length !== 64
      || sourceMain.length !== 64
    ) {
      skipProduction("canonical state has no valid tree-integrity evidence");
    } else if (recorded !== current) {
      skipProduction("canonical state does not describe this source tree");
    } else if (sourceMain !== current) {
      skipProduction("source changed since the recorded main base; merge a state refresh");
    } else if (!localGatesPass(snapshot?.gates, current)) {
      skipProduction("local source gates are stale, incomplete, or failing for this tree");
    } else if (
      snapshot?.git?.fingerprint
      !== stateEvidenceFingerprint(current, {
        gates: snapshot?.gates,
        provenance,
        sourceMainContentTreeHash: sourceMain,
      })
    ) {
      skipProduction("canonical state fingerprint is invalid");
    } else {
      continueBuild(
        "canonical state is aligned; external owner-controlled release authorization remains required",
      );
    }
  } catch {
    skipProduction("state evidence could not be verified");
  }
} else {
  skipProduction("VERCEL_ENV is missing or unknown");
}
