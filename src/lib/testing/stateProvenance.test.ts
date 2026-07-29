import { describe, expect, it } from "vitest";
import { stateEvidenceFingerprint } from "../../../scripts/state-tree-integrity.mjs";
import { validateStateSnapshotProvenance } from "../../../scripts/state-provenance.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(64);
const BASE_TREE = "d".repeat(64);
const AHEAD = [{ sha: HEAD.slice(0, 8), subject: "fix(governance): tested provenance" }];

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    branch: "codex/governance",
    head: HEAD,
    mainHead: BASE,
    workingTreeClean: true,
    aheadOfMain: AHEAD,
    contentTreeHash: TREE,
    sourceMainContentTreeHash: BASE_TREE,
    ...overrides,
  };
}

function validate(persistedGit = snapshot()) {
  return validateStateSnapshotProvenance({
    persistedGit,
    checkTarget: "candidate",
    protectedMainRef: "origin/main",
    expectedBranch: "codex/governance",
    expectedContentTreeHash: TREE,
    expectedSourceMainContentTreeHash: BASE_TREE,
    expectedGateSourceHead: HEAD,
    expectedGateSourceContentTreeHash: TREE,
    requireMeasuredGateBinding: true,
    git: (...args: string[]) => {
      if (args[0] === "rev-parse") {
        if (args[1] === "origin/main") return BASE;
        return typeof args[1] === "string" && /^[a-f]+$/.test(args[1]) ? args[1] : "";
      }
      if (args[0] === "merge-base") return BASE;
      if (args[0] === "log") return `${HEAD}\u001f${AHEAD[0].subject}`;
      throw new Error(`unexpected git invocation ${args.join(" ")}`);
    },
    contentTreeHash: (ref: string) => ref === BASE ? BASE_TREE : ref === "e".repeat(40) ? "f".repeat(64) : TREE,
  });
}

describe("persisted generated-state provenance", () => {
  it("accepts only an independently reproducible candidate/base snapshot", () => {
    expect(validate()).toEqual([]);
  });

  it("rejects a recomputed-fingerprint provenance tamper", () => {
    const tampered = snapshot({
      mainHead: "e".repeat(40),
      sourceMainContentTreeHash: "f".repeat(64),
      aheadOfMain: [],
    });
    const fingerprint = stateEvidenceFingerprint(TREE, {
      gates: { sourceHead: HEAD, sourceContentTreeHash: TREE },
      provenance: tampered,
      sourceMainContentTreeHash: tampered.sourceMainContentTreeHash,
    });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(validate(tampered)).toEqual(expect.arrayContaining([
      "generated state provenance sourceMainContentTreeHash does not match the checked protected base tree",
      "generated state provenance mainHead does not equal the independently resolved protected base",
      "generated state provenance mainHead is not an ancestor of provenance head",
      "generated state provenance aheadOfMain does not exactly describe mainHead..head",
    ]));
  });

  it("rejects an in-place ahead-of-main history tamper", () => {
    expect(validate(snapshot({ aheadOfMain: [] }))).toContain(
      "generated state provenance aheadOfMain does not exactly describe mainHead..head",
    );
  });

  it("rejects branch, measured-head, and clean-tree provenance tampering", () => {
    expect(validate(snapshot({ branch: "unreviewed-branch" }))).toContain(
      "generated state provenance branch does not match the independently selected PR branch",
    );
    expect(validate(snapshot({ head: "e".repeat(40) }))).toEqual(expect.arrayContaining([
      "generated state provenance head does not match measured gate sourceHead",
      "generated state provenance head content tree does not match persisted contentTreeHash",
    ]));
    expect(validate(snapshot({ workingTreeClean: false }))).toContain(
      "generated state provenance workingTreeClean must be true for a measured candidate",
    );
  });

  it("rejects measured evidence that omits its source bindings", () => {
    expect(validateStateSnapshotProvenance({
      persistedGit: snapshot(),
      checkTarget: "candidate",
      protectedMainRef: "origin/main",
      expectedContentTreeHash: TREE,
      expectedSourceMainContentTreeHash: BASE_TREE,
      requireMeasuredGateBinding: true,
      git: (...args: string[]) => args[0] === "log" ? `${HEAD}\u001f${AHEAD[0].subject}` : args[1] === "origin/main" ? BASE : args[1] ?? "",
      contentTreeHash: (ref: string) => ref === BASE ? BASE_TREE : TREE,
    })).toEqual(expect.arrayContaining([
      "measured gate evidence must bind a lowercase full sourceHead SHA",
      "measured gate evidence must bind a sourceContentTreeHash SHA-256",
    ]));
  });

  it("allows an equivalent protected merge only after proving the historical base and candidate trees", () => {
    expect(validateStateSnapshotProvenance({
      persistedGit: snapshot(),
      checkTarget: "protected-main",
      protectedMainRef: "current-main",
      expectedBranch: "main",
      expectedContentTreeHash: TREE,
      expectedSourceMainContentTreeHash: "changed".repeat(11).slice(0, 64),
      expectedGateSourceHead: HEAD,
      expectedGateSourceContentTreeHash: TREE,
      requireMeasuredGateBinding: true,
      allowEquivalentProtectedMerge: true,
      git: (...args: string[]) => {
        if (args[0] === "rev-parse") return args[1] === "current-main" ? "z".repeat(40) : args[1] ?? "";
        if (args[0] === "merge-base") return BASE;
        if (args[0] === "log") return `${HEAD}\u001f${AHEAD[0].subject}`;
        throw new Error(`unexpected git invocation ${args.join(" ")}`);
      },
      contentTreeHash: (ref: string) => ref === BASE ? BASE_TREE : TREE,
    })).toEqual([]);
  });

  it("permits a carried gate sourceHead only when the caller proved an aligned state refresh", () => {
    const refreshedHead = "f".repeat(40);
    const refreshed = snapshot({
      head: refreshedHead,
      aheadOfMain: [{ sha: refreshedHead.slice(0, 8), subject: "docs(state): refresh" }],
    });
    const params = {
      persistedGit: refreshed,
      checkTarget: "candidate",
      protectedMainRef: "origin/main",
      expectedBranch: "codex/governance",
      expectedContentTreeHash: TREE,
      expectedSourceMainContentTreeHash: BASE_TREE,
      expectedGateSourceHead: HEAD,
      expectedGateSourceContentTreeHash: TREE,
      requireMeasuredGateBinding: true,
      git: (...args: string[]) => {
        if (args[0] === "rev-parse") {
          if (args[1] === "origin/main") return BASE;
          return args[1] ?? "";
        }
        if (args[0] === "merge-base") return BASE;
        if (args[0] === "log") return `${refreshedHead}\u001fdocs(state): refresh`;
        throw new Error(`unexpected git invocation ${args.join(" ")}`);
      },
      contentTreeHash: (ref: string) => ref === BASE ? BASE_TREE : TREE,
    };
    expect(validateStateSnapshotProvenance(params)).toContain(
      "generated state provenance head does not match measured gate sourceHead",
    );
    expect(validateStateSnapshotProvenance({
      ...params,
      allowAlignedGateSourceHeadCarry: true,
    })).toEqual([]);
  });
});
