const SHA_40 = /^[a-f0-9]{40}$/;

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Verify the historical provenance retained by state:check without replacing it
 * with the executing worktree's topology.  A checked-out PR can be a synthetic
 * merge commit and a later protected squash has a different commit id, so the
 * rendered provenance deliberately stays historical.  It is nevertheless
 * evidence, not free-form text: every persisted relation must be reproducible
 * from the candidate and protected-base objects supplied by the caller.
 */
export function validateStateSnapshotProvenance(params) {
  const {
  git,
  contentTreeHash,
  persistedGit,
  checkTarget,
  protectedMainRef,
  expectedBranch = undefined,
  expectedContentTreeHash,
  expectedSourceMainContentTreeHash,
  expectedGateSourceHead = undefined,
  expectedGateSourceContentTreeHash = undefined,
  requireMeasuredGateBinding = false,
  allowEquivalentProtectedMerge = false,
  allowAlignedGateSourceHeadCarry = false,
  } = params;
  const errors = [];
  if (!persistedGit || typeof persistedGit !== "object") {
    return ["generated state provenance is missing or invalid"];
  }

  const { branch, head, mainHead, workingTreeClean, aheadOfMain, contentTreeHash: persistedContentTreeHash, sourceMainContentTreeHash } = persistedGit;
  if (typeof branch !== "string" || branch.length === 0) {
    errors.push("generated state provenance branch must be a non-empty string");
  }
  if (!SHA_40.test(head ?? "")) {
    errors.push("generated state provenance head must be a lowercase full 40-character SHA");
  }
  if (!SHA_40.test(mainHead ?? "")) {
    errors.push("generated state provenance mainHead must be a lowercase full 40-character SHA");
  }
  if (workingTreeClean !== true) {
    errors.push("generated state provenance workingTreeClean must be true for a measured candidate");
  }
  if (!Array.isArray(aheadOfMain)) {
    errors.push("generated state provenance aheadOfMain must be an array");
  }
  if (typeof persistedContentTreeHash !== "string" || persistedContentTreeHash.length !== 64) {
    errors.push("generated state provenance contentTreeHash must be a SHA-256 string");
  }
  if (typeof sourceMainContentTreeHash !== "string" || sourceMainContentTreeHash.length !== 64) {
    errors.push("generated state provenance sourceMainContentTreeHash must be a SHA-256 string");
  }
  if (errors.length > 0) return errors;

  if (!allowEquivalentProtectedMerge && expectedBranch && branch !== expectedBranch) {
    errors.push("generated state provenance branch does not match the independently selected PR branch");
  }
  if (persistedContentTreeHash !== expectedContentTreeHash) {
    errors.push("generated state provenance contentTreeHash does not match the checked candidate source tree");
  }
  if (!allowEquivalentProtectedMerge && sourceMainContentTreeHash !== expectedSourceMainContentTreeHash) {
    errors.push("generated state provenance sourceMainContentTreeHash does not match the checked protected base tree");
  }
  if (requireMeasuredGateBinding && !SHA_40.test(expectedGateSourceHead ?? "")) {
    errors.push("measured gate evidence must bind a lowercase full sourceHead SHA");
  } else if (
    expectedGateSourceHead
    && head !== expectedGateSourceHead
    && !allowAlignedGateSourceHeadCarry
  ) {
    errors.push("generated state provenance head does not match measured gate sourceHead");
  }
  if (requireMeasuredGateBinding && (typeof expectedGateSourceContentTreeHash !== "string" || expectedGateSourceContentTreeHash.length !== 64)) {
    errors.push("measured gate evidence must bind a sourceContentTreeHash SHA-256");
  } else if (expectedGateSourceContentTreeHash && persistedContentTreeHash !== expectedGateSourceContentTreeHash) {
    errors.push("generated state provenance contentTreeHash does not match measured gate sourceContentTreeHash");
  }

  try {
    if (git("rev-parse", head) !== head) {
      errors.push("generated state provenance head is not an exact resolvable commit");
    }
  } catch {
    errors.push("generated state provenance head is not a resolvable commit");
  }
  try {
    if (git("rev-parse", mainHead) !== mainHead) {
      errors.push("generated state provenance mainHead is not an exact resolvable commit");
    }
  } catch {
    errors.push("generated state provenance mainHead is not a resolvable commit");
  }
  if (errors.some((error) => error.includes("resolvable commit") || error.includes("exact resolvable commit"))) {
    return errors;
  }

  try {
    const relationshipBase = allowEquivalentProtectedMerge ? mainHead : protectedMainRef;
    if (!allowEquivalentProtectedMerge && git("rev-parse", protectedMainRef) !== mainHead) {
      errors.push("generated state provenance mainHead does not equal the independently resolved protected base");
    }
    if (git("merge-base", relationshipBase, head) !== mainHead) {
      errors.push("generated state provenance mainHead is not an ancestor of provenance head");
    }
    if (contentTreeHash(head) !== persistedContentTreeHash) {
      errors.push("generated state provenance head content tree does not match persisted contentTreeHash");
    }
    if (contentTreeHash(mainHead) !== sourceMainContentTreeHash) {
      errors.push("generated state provenance mainHead content tree does not match persisted sourceMainContentTreeHash");
    }
    if (contentTreeHash(checkTarget) !== persistedContentTreeHash) {
      errors.push("checked target source tree does not match persisted provenance contentTreeHash");
    }
    const actualAhead = git("log", `${mainHead}..${head}`, "--format=%H%x1f%s")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha: sha.slice(0, 8), subject };
      });
    if (!sameJson(actualAhead, aheadOfMain)) {
      errors.push("generated state provenance aheadOfMain does not exactly describe mainHead..head");
    }
  } catch {
    errors.push("generated state provenance relationships could not be independently verified");
  }
  return errors;
}
