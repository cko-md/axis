import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards two derivation rules in scripts/derive-program-state.mjs.
 *
 * docs/CURRENT_STATE.md's "waves merged to main" table is what tells the next
 * session "this is done, do not restart it." Both rules below exist because the
 * table got that wrong in a way nothing else would have caught.
 *
 * Source-level assertions, following the precedent set by
 * src/lib/vector/bundle-partition.test.ts: the script is a CLI entry point with
 * top-level side effects (it shells out to git on import), so its internals are
 * not importable without running them.
 */

const SCRIPT = "scripts/derive-program-state.mjs";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("program state derivation", () => {
  const source = read(SCRIPT);

  it("does not require a PR number to count a commit as merged", () => {
    // The original `if (!match) continue;` skipped every commit without a
    // `(#123)` suffix, so a wave merged locally (fast-forward, no PR) vanished
    // from the table entirely — main contained it while the canonical doc said
    // nothing. Waves 15.2 and 15.8 were both invisible this way.
    expect(source).toMatch(/pr:\s*match\s*\?\s*Number\(match\[1\]\)\s*:\s*null/);
    expect(
      /const match = subject\.match\(\/\\\(#\(\\d\+\)\\\)\\s\*\$\/\);\s*\n\s*if \(!match\) continue;/.test(source),
      "deriveMergedPrs still skips commits with no PR number",
    ).toBe(false);
  });

  it("renders provenance for a wave that has no PR", () => {
    expect(source).toMatch(/function prLabel\(/);
    expect(source).toMatch(/mergedPr === null \? "local merge"/);
    // Every place that used to interpolate `#${wave.mergedPr}` must go through
    // prLabel, or a locally merged wave renders as the literal "PR #null".
    expect(source).not.toMatch(/#\$\{wave\.mergedPr\}/);
  });

  it("attributes a wave to the commit that implemented it, not the one that recorded it", () => {
    // With a squash-merged PR the implementing and recording commits are the
    // same. With a locally merged branch the follow-up docs commit is newer and
    // would win the newest-first scan, pointing the table at a commit that
    // changed no product code.
    expect(source).toMatch(/const isDocs = \/\^docs\[\(:\]\/i\.test\(pr\.subject\)/);
    expect(source).toMatch(/existing\.isDocs && !isDocs/);
  });
});
