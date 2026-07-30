import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * These two files are generated from the committed repository and therefore
 * cannot include their own blob ids in the content hash they record.
 *
 * Authored policy, including PROGRAM_STATE.json, is intentionally NOT excluded.
 * A policy edit is a source-state change and requires a subsequent canonical
 * state refresh before production may build.
 */
export const GENERATED_STATE_ARTIFACTS = new Set([
  ".claude/axis-redesign/GENERATED_STATE.json",
  "docs/CURRENT_STATE.md",
]);

export function gitTreeContentHash({ cwd = process.cwd(), ref = "HEAD" } = {}) {
  const tree = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", ref],
    { cwd, encoding: "utf8" },
  );
  const entries = tree
    .split("\0")
    .filter(Boolean)
    .filter((entry) => {
      const tab = entry.indexOf("\t");
      return tab !== -1 && !GENERATED_STATE_ARTIFACTS.has(entry.slice(tab + 1));
    })
    .sort();

  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function stateEvidenceFingerprint(contentTreeHash, boundEvidence) {
  // Deterministic consistency checksum only. This is not a signature or
  // attestation: anyone who can edit the candidate tree can recompute it.
  // Merge authority comes from the independently pinned owner-controlled
  // executor. Base-controlled and hosted checks are evidence it verifies.
  return createHash("sha256")
    .update(contentTreeHash)
    .update("\0bound-state-evidence\0")
    .update(stableJson(boundEvidence))
    .digest("hex");
}
