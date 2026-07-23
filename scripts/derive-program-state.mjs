#!/usr/bin/env node
/**
 * Derive program state from the repository itself, then write it to a single
 * canonical file that any tool — Claude Code, Codex, Cursor — reads first.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Checkpoint docs drifted badly: PROGRAM_STATE.json described waves 15.3, 15.4,
 * 15.5, 16.0, 16.1 and 16.2 as "PR pending owner merge" when all six were long
 * since merged to main, and VE-CONTINUE-CLAUDE.md still directed the next
 * session to start Wave 15.4 — work that had already shipped. A resuming agent
 * following those docs would redo finished work.
 *
 * The root cause is not carelessness. It is that facts which are MECHANICALLY
 * DERIVABLE (what merged, at which sha, how many tests pass) were being
 * maintained by hand, in prose, by whoever remembered. Anything hand-maintained
 * drifts. So this script derives those facts and owns them outright.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * Generated content lives ONLY between the GENERATED markers below. Human
 * narrative outside those markers is never touched. That separation is what
 * makes it safe to run this on every push.
 *
 * ── Modes ────────────────────────────────────────────────────────────────────
 *   node scripts/derive-program-state.mjs              # write derived state
 *   node scripts/derive-program-state.mjs --check      # drift detector, CI
 *   node scripts/derive-program-state.mjs --gates      # also run test/build
 *
 * --check exits non-zero when a checkpoint doc contradicts derivable truth.
 * That is the piece that stops this from silently rotting again.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  GENERATED_STATE_ARTIFACTS,
  gitTreeContentHash,
  stateEvidenceFingerprint,
} from "./state-tree-integrity.mjs";

const REPO = process.cwd();
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const WITH_GATES = args.has("--gates");

const GENERATED_JSON = ".claude/axis-redesign/GENERATED_STATE.json";
const CANONICAL_DOC = "docs/CURRENT_STATE.md";
const BEGIN = "<!-- BEGIN GENERATED: derive-program-state -->";
const END = "<!-- END GENERATED: derive-program-state -->";
function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: REPO, encoding: "utf8" }).trim();
}

function resolveCheckTargetRef() {
  // A pull-request workflow often checks GitHub's synthetic merge commit. The
  // generated-state commit is on the PR head (the merge commit's second
  // parent), not on that synthetic commit. Checking the PR head applies the
  // same committed-tree fingerprint contract locally and in PR CI. Callers
  // that use a different CI topology may provide the exact head through this explicit
  // override.
  if (process.env.AXIS_STATE_TARGET_REF) return process.env.AXIS_STATE_TARGET_REF;

  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      git("rev-parse", "--verify", "HEAD^2");
      return "HEAD^2";
    } catch {
      // A non-merge checkout of a pull request is already the PR head.
    }
  }

  return "HEAD";
}

/**
 * Resolve the mainline ref.
 *
 * On a CI pull-request checkout there is no local `main` branch — only
 * `origin/main` — so hard-coding "main" makes every derivation throw in exactly
 * the environment where the drift check matters most.
 */
function resolveMainRef() {
  for (const candidate of ["origin/main", "refs/remotes/origin/main", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", candidate], {
        cwd: REPO,
        stdio: "ignore",
      });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "Canonical state derivation requires a reviewed main ref. "
    + "Fetch origin/main (full history for state derivation) before running this command.",
  );
}

const MAIN_REF = resolveMainRef();

function readJson(relativePath) {
  const full = path.join(REPO, relativePath);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

function readJsonAtRef(relativePath, ref) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${ref}:${relativePath}`], {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Commits on main, read from git rather than from anyone's memory. Squash-merge
 * subjects carry the PR number, which is what makes provenance reliable.
 *
 * A PR number is NOT required. A wave merged locally (fast-forward, no PR) is
 * still merged, and an earlier version of this function skipped every commit
 * without a `(#123)` suffix — which silently dropped such a wave from the
 * "waves merged to main" table. That is exactly the quiet omission this script
 * exists to prevent, so `pr` is now null rather than a reason to skip.
 */
function deriveMergedPrs() {
  // `%h` is object-database dependent: the same commit may render at a
  // different abbreviation length in a shallow CI checkout than it does in a
  // developer clone. Keep complete object IDs in the derivation, then render a
  // fixed prefix below so the committed state block is clone-independent.
  const log = git("log", "--format=%H%x1f%s%x1f%cI", MAIN_REF);
  const prs = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, subject, committedAt] = line.split("\x1f");
    const match = subject.match(/\(#(\d+)\)\s*$/);
    prs.push({
      pr: match ? Number(match[1]) : null,
      sha: sha.slice(0, 8),
      subject: subject.replace(/\s*\(#\d+\)\s*$/, ""),
      committedAt,
    });
  }
  return prs;
}

/** How a wave's provenance renders when it was merged without a PR. */
function prLabel(mergedPr) {
  return mergedPr === null ? "local merge" : `#${mergedPr}`;
}

/**
 * Waves are named in commit subjects ("Wave 15.4", "Phase 16.2"). Deriving the
 * wave->PR->sha mapping from commits is what makes "is this merged?" a fact
 * instead of an assertion.
 */
function deriveWaves(prs) {
  const waves = {};
  for (const pr of prs) {
    // A single commit can land more than one wave, and only the first is
    // prefixed: "Phase 16.0 ADR + 16.1 bring-your-own-emulator launcher".
    // Matching only the prefixed form silently loses 16.1 — precisely the kind
    // of quiet omission this script exists to prevent. So once a subject is
    // known to be wave-bearing, collect every version-like token in it.
    if (!/\b(?:Wave|Phase)\s+\d+\.\d+/i.test(pr.subject)) continue;
    // A wave landed in the commit that IMPLEMENTED it, not in the docs commit
    // that recorded it afterwards. With a squash-merged PR the two are the same
    // commit so this never matters; with a locally merged branch the docs
    // commit is newer and would otherwise win, attributing the wave to a commit
    // that changed no product code.
    const isDocs = /^docs[(:]/i.test(pr.subject);
    for (const match of pr.subject.matchAll(/\b(\d+\.\d+)\b/g)) {
      const id = match[1];
      const existing = waves[id];
      if (existing && !(existing.isDocs && !isDocs)) continue;
      waves[id] = {
        wave: id,
        mergedPr: pr.pr,
        sha: pr.sha,
        subject: pr.subject,
        mergedAt: pr.committedAt,
        isDocs,
      };
    }
  }
  return Object.values(waves).sort((a, b) =>
    a.wave.localeCompare(b.wave, undefined, { numeric: true }),
  );
}

function deriveMigrations(ref) {
  let listing;
  try {
    listing = git("ls-tree", "-r", "--name-only", ref, "--", "supabase/migrations");
  } catch {
    return { count: 0, latest: null };
  }
  const files = listing
    .split("\n")
    .map((name) => path.basename(name))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return { count: files.length, latest: files.at(-1) ?? null };
}

function deriveDefects(ref) {
  const ledger = readJsonAtRef(".claude/axis-redesign/DEFECT_LEDGER.json", ref);
  if (!ledger) return { total: 0, open: 0, openIds: [] };
  const entries = Array.isArray(ledger.defects)
    ? ledger.defects
    : Array.isArray(ledger.entries)
      ? ledger.entries
      : [];
  const open = entries.filter((entry) => entry?.status && entry.status !== "fixed" && entry.status !== "closed");
  return {
    total: entries.length,
    open: open.length,
    openIds: open.map((entry) => entry.id ?? entry.defect_id ?? "unknown"),
  };
}

const LOCAL_GATE_CONTRACT =
  "exact committed source: typecheck, lint, full unit suite, clean Next production build, aggregate bundle budget";
const BUILD_GENERATED_SCOPES = [
  "public/vector-assets/manifests",
  "public/vector-assets/offline",
];

function commandOutput(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const label = [command, ...commandArgs].join(" ");
    throw new Error(
      `Local state gate failed: ${label} (exit ${error?.status ?? "unknown"})`,
      { cause: error },
    );
  }
}

function statusRecords() {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: REPO, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

function isGeneratedStateRecord(record) {
  return [...GENERATED_STATE_ARTIFACTS].some(
    (relativePath) => record.slice(3) === relativePath,
  );
}

function assertExactCommittedInputs() {
  const changes = statusRecords().filter((record) => !isGeneratedStateRecord(record));
  if (changes.length > 0) {
    throw new Error(
      "Local state gates require an exact committed tree. Commit or remove every "
      + `non-state change first (${changes.length} path(s) differ).`,
    );
  }
}

function snapshotPath(fullPath) {
  if (!existsSync(fullPath)) return null;
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Local state gate refuses a symlink in build output scope: ${fullPath}`);
  }
  if (stat.isDirectory()) {
    return {
      type: "directory",
      mode: stat.mode,
      children: readdirSync(fullPath)
        .sort()
        .map((name) => [name, snapshotPath(path.join(fullPath, name))]),
    };
  }
  if (!stat.isFile()) {
    throw new Error(`Local state gate found an unsupported build output entry: ${fullPath}`);
  }
  return { type: "file", mode: stat.mode, contents: readFileSync(fullPath) };
}

function restorePath(fullPath, snapshot) {
  rmSync(fullPath, { recursive: true, force: true });
  if (snapshot === null) return;
  if (snapshot.type === "directory") {
    mkdirSync(fullPath, { recursive: true });
    chmodSync(fullPath, snapshot.mode);
    for (const [name, child] of snapshot.children) {
      restorePath(path.join(fullPath, name), child);
    }
    return;
  }
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, snapshot.contents);
  chmodSync(fullPath, snapshot.mode);
}

function snapshotBuildArtifacts() {
  return BUILD_GENERATED_SCOPES.map((relativePath) => ({
    relativePath,
    snapshot: snapshotPath(path.join(REPO, relativePath)),
  }));
}

function restoreBuildArtifacts(snapshots) {
  for (const { relativePath, snapshot } of snapshots) {
    restorePath(path.join(REPO, relativePath), snapshot);
  }
}

/**
 * Gate figures require actually running the gates, so they are opt-in. A normal
 * derive preserves a measured pass only when it is bound to the identical
 * content tree; otherwise prior figures are explicitly marked stale.
 */
function deriveGates(previous, contentTreeHash) {
  if (!WITH_GATES) {
    const carried = previous?.gates ?? null;
    if (
      carried?.measured === true
      && previous?.git?.contentTreeHash === contentTreeHash
      && carried.sourceContentTreeHash === contentTreeHash
    ) {
      return carried;
    }
    return carried
      ? { ...carried, measured: false, note: "carried forward; re-run with --gates to measure" }
      : { measured: false, note: "never measured; run with --gates" };
  }

  assertExactCommittedInputs();
  const measuredHead = git("rev-parse", "HEAD");
  const gates = {
    measured: false,
    contract: LOCAL_GATE_CONTRACT,
    sourceHead: measuredHead,
    sourceContentTreeHash: contentTreeHash,
  };

  commandOutput("npx", ["tsc", "--noEmit"]);
  gates.typecheck = { passed: true };
  commandOutput("npm", ["run", "lint"]);
  gates.lint = { passed: true };

  const out = commandOutput("npx", ["vitest", "run", "--reporter=json"]);
  const jsonStart = out.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Local state gate failed: Vitest did not emit JSON results.");
  }
  const parsed = JSON.parse(out.slice(jsonStart));
  if (
    parsed.success !== true
    || parsed.numFailedTests !== 0
    || parsed.numPassedTests !== parsed.numTotalTests
  ) {
    throw new Error("Local state gate failed: Vitest reported a failing or incomplete suite.");
  }
  // testResults is one entry per FILE. numTotalTestSuites counts describe
  // blocks (478 vs 193 here), so keep both figures distinct.
  gates.tests = {
    passed: parsed.numPassedTests,
    total: parsed.numTotalTests,
    files: Array.isArray(parsed.testResults) ? parsed.testResults.length : undefined,
    suites: parsed.numTotalTestSuites,
  };

  rmSync(path.join(REPO, ".next"), { recursive: true, force: true });
  const buildArtifactSnapshots = snapshotBuildArtifacts();
  try {
    commandOutput("npm", ["run", "build"]);
    if (!existsSync(path.join(REPO, ".next", "BUILD_ID"))) {
      throw new Error(
        "Local state gate failed: the production build exited zero without a fresh .next/BUILD_ID.",
      );
    }
    gates.build = { passed: true, cleanOutput: true };

    const bundle = commandOutput(process.execPath, ["scripts/check-bundle-budget.mjs"]);
    const measurements = [
      ...bundle.matchAll(/(\d+)\s*KB\s*\/\s*(\d+)\s*KB/g),
    ];
    if (measurements.length < 2) {
      throw new Error(
        "Local state gate failed: bundle budget emitted incomplete shared/game measurements.",
      );
    }
    gates.bundleKb = {
      used: Number(measurements[0][1]),
      budget: Number(measurements[0][2]),
    };
    gates.routeIsolatedBundleKb = {
      used: Number(measurements[1][1]),
      budget: Number(measurements[1][2]),
    };
  } finally {
    restoreBuildArtifacts(buildArtifactSnapshots);
  }

  assertExactCommittedInputs();
  if (git("rev-parse", "HEAD") !== measuredHead) {
    throw new Error("Local state gate failed: HEAD changed during measurement.");
  }

  gates.measured = true;
  gates.measuredAt = new Date().toISOString();
  return gates;
}

function gatesForCheck(previous) {
  // Gate measurements are evidence produced by --gates, not facts that a fast
  // --check can reproduce. The committed GENERATED_STATE snapshot is their
  // source of truth: check renders that snapshot verbatim. A normal write keeps
  // it only for identical content, otherwise deriveGates() marks it stale.
  return previous?.gates ?? { measured: false, note: "never measured; run with --gates" };
}

function deriveState(previous, ref = "HEAD") {
  const prs = deriveMergedPrs();
  const contentTreeHash = gitTreeContentHash({ cwd: REPO, ref });
  const gates = CHECK_ONLY
    ? gatesForCheck(previous)
    : deriveGates(previous, contentTreeHash);
  const observedMainContentTreeHash = gitTreeContentHash({ cwd: REPO, ref: MAIN_REF });
  const observedProvenance = {
    branch: ref === "HEAD" ? git("rev-parse", "--abbrev-ref", "HEAD") : "checked target",
    head: git("rev-parse", ref),
    mainHead: git("rev-parse", MAIN_REF),
    workingTreeClean: git("status", "--porcelain") === "",
    aheadOfMain: [],
  };

  // Commits on this branch that main does not have. This is precisely the
  // information a resuming agent needs and the thing prose always gets wrong.
  if (observedProvenance.branch !== "main") {
    const ahead = git("log", `${MAIN_REF}..${ref}`, "--format=%H%x1f%s");
    observedProvenance.aheadOfMain = ahead
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha: sha.slice(0, 8), subject };
      });
  }

  // Source commit/branch names are topology-sensitive provenance. During a
  // check, preserve the committed snapshot's provenance and bind it into the
  // fingerprint. Equivalent squash/merge content remains valid, while changing
  // either the rendered provenance or its JSON snapshot changes the expected
  // fingerprint.
  const persistedGit = previous?.git;
  const provenance = CHECK_ONLY && persistedGit
    ? {
        branch: persistedGit.branch,
        head: persistedGit.head,
        mainHead: persistedGit.mainHead,
        workingTreeClean: persistedGit.workingTreeClean,
        aheadOfMain: Array.isArray(persistedGit.aheadOfMain) ? persistedGit.aheadOfMain : [],
      }
    : observedProvenance;
  const sourceMainContentTreeHash = CHECK_ONLY && persistedGit?.sourceMainContentTreeHash
    ? persistedGit.sourceMainContentTreeHash
    : observedMainContentTreeHash;
  const fingerprint = stateEvidenceFingerprint(contentTreeHash, {
    gates,
    provenance,
    sourceMainContentTreeHash,
  });

  return {
    $schema: "derived — do not hand-edit; run scripts/derive-program-state.mjs",
    derivedAt: new Date().toISOString(),
    git: {
      ...provenance,
      contentTreeHash,
      sourceMainContentTreeHash,
      fingerprint,
    },
    mergedPrs: prs.slice(0, 25),
    waves: deriveWaves(prs),
    migrations: deriveMigrations(ref),
    defects: deriveDefects(ref),
    gates,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMarkdown(state) {
  const lines = [];
  lines.push(BEGIN);
  lines.push("");
  lines.push("_Deterministically derived from committed repository content. Do not hand-edit this block._");
  lines.push("");
  lines.push("## Repository state identity");
  lines.push("");
  lines.push(`- **State fingerprint:** \`${state.git.fingerprint}\` (committed tree plus bound provenance/gate evidence; only the two generated state artifacts are excluded)`);
  lines.push(`- **Content tree:** \`${state.git.contentTreeHash}\``);
  lines.push(`- **Source-main tree at derivation:** \`${state.git.sourceMainContentTreeHash}\``);
  lines.push("- **Production release rule:** source-main alignment is evaluated by Vercel at deploy time; this snapshot records the derivation-time source-main tree and does not claim current alignment after a merge.");
  lines.push("- An equivalent squash/merge preserves every rendered derived fact. A new numeric wave or other fact change requires a protected state refresh.");
  lines.push("");
  lines.push("## Source snapshot provenance");
  lines.push("");
  lines.push("_Informational origin of this snapshot. The fingerprint, not commit topology, establishes currency after an equivalent squash or merge._");
  lines.push("");
  lines.push(`- **Branch:** \`${state.git.branch}\``);
  lines.push(`- **HEAD:** \`${state.git.head.slice(0, 8)}\``);
  lines.push(`- **main:** \`${state.git.mainHead.slice(0, 8)}\``);
  lines.push(`- **Working tree:** ${state.git.workingTreeClean ? "clean" : "had uncommitted changes"}`);

  if (state.git.aheadOfMain.length > 0) {
    lines.push("");
    lines.push(`### Ahead of source main at derivation (${state.git.aheadOfMain.length} commit(s))`);
    lines.push("");
    for (const commit of state.git.aheadOfMain) {
      lines.push(`- \`${commit.sha}\` ${commit.subject}`);
    }
  }

  lines.push("");
  lines.push("## Waves merged to main");
  lines.push("");
  if (state.waves.length === 0) {
    lines.push("_No wave-tagged commits found._");
  } else {
    lines.push("| Wave | PR | Commit | Subject |");
    lines.push("| --- | --- | --- | --- |");
    for (const wave of state.waves) {
      lines.push(`| ${wave.wave} | ${prLabel(wave.mergedPr)} | \`${wave.sha}\` | ${wave.subject} |`);
    }
    lines.push("");
    lines.push("Every row above is **merged**. A wave listed here is done; do not restart it.");
  }

  lines.push("");
  lines.push("## Database");
  lines.push("");
  lines.push(`- **Tracked migrations:** ${state.migrations.count}`);
  lines.push(`- **Latest:** \`${state.migrations.latest ?? "none"}\``);

  lines.push("");
  lines.push("## Defects");
  lines.push("");
  lines.push(`- **Total logged:** ${state.defects.total}`);
  lines.push(`- **Open:** ${state.defects.open}${state.defects.open > 0 ? ` (${state.defects.openIds.join(", ")})` : ""}`);

  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push(`_Local source evidence is persisted in \`${GENERATED_JSON}\` and bound into the state fingerprint. It is not the hosted production-readiness gate. A normal derive preserves a measured pass only when the content-tree hash is identical; otherwise it marks the evidence stale. \`--gates\` runs typecheck, lint, the full unit suite, a clean production build, and the aggregate bundle budget._`);
  lines.push("");
  if (state.gates.measured) {
    if (state.gates.tests?.total) {
      lines.push(`- **Tests:** ${state.gates.tests.passed}/${state.gates.tests.total} across ${state.gates.tests.files} files`);
    }
    if (state.gates.bundleKb) {
      lines.push(`- **Bundle:** ${state.gates.bundleKb.used} KB / ${state.gates.bundleKb.budget} KB`);
    }
    if (state.gates.routeIsolatedBundleKb) {
      lines.push(`- **Route-isolated game bundle:** ${state.gates.routeIsolatedBundleKb.used} KB / ${state.gates.routeIsolatedBundleKb.budget} KB`);
    }
    lines.push(`- **Measured source:** \`${state.gates.sourceHead?.slice(0, 8) ?? "unknown"}\``);
    lines.push(`- **Measured content tree:** \`${state.gates.sourceContentTreeHash ?? "unknown"}\``);
    lines.push(`- **Measured at:** ${state.gates.measuredAt}`);
  } else {
    lines.push(`- _${state.gates.note}_`);
    if (state.gates.tests?.total) {
      lines.push(`- Last known tests: ${state.gates.tests.passed}/${state.gates.tests.total} (STALE)`);
    }
  }

  lines.push("");
  lines.push(END);
  return lines.join("\n");
}

const DOC_PREAMBLE = `# Current state

**Read this file first.** It is the single canonical entry point for any agent or
tool resuming work on this repository — Claude Code, Codex, Cursor, or a human.

The block below is generated from the repository by
\`scripts/derive-program-state.mjs\`. It is the authority on what is merged, what
is only on a branch, and what the gates last measured. Where any other document
disagrees with it, this file wins and the other document is stale.

Commit SHA, branch name, and merge topology are displayed as source provenance,
but they are not stable currency identifiers through a protected squash or
merge. State currency uses the displayed SHA-256 fingerprint of the committed
tree plus fingerprint-bound provenance and gate evidence. Only
\`${GENERATED_JSON}\` and this Markdown file are excluded to avoid an impossible
self-reference; authored policy such as \`PROGRAM_STATE.json\` remains in the
hash. The generated Markdown block is compared byte-for-byte with a
deterministic re-render. Narrative outside the generated markers is deliberately
not integrity-bound and is not release authority. "Equivalent" is intentionally
narrow: a merge that introduces a new numeric wave or otherwise changes a
rendered fact must be followed by a protected state refresh.

Narrative context that cannot be derived — intent, owner decisions, what to do
next and why — lives in the sections *after* the generated block and is written
by humans and agents. Never hand-edit inside the generated markers; run:

\`\`\`
npm run state:derive          # refresh
npm run state:check           # fail if any checkpoint doc contradicts reality
\`\`\`

`;

const DOC_NARRATIVE_DEFAULT = `
## Working notes

_Human- and agent-authored. Safe to edit. Keep it short and current; delete what
is no longer true rather than appending._

`;

function writeCanonicalDoc(state) {
  const full = path.join(REPO, CANONICAL_DOC);
  const generated = renderMarkdown(state);

  if (!existsSync(full)) {
    writeFileSync(full, `${DOC_PREAMBLE}${generated}\n${DOC_NARRATIVE_DEFAULT}`);
    return;
  }

  const existing = readFileSync(full, "utf8");
  const start = existing.indexOf(BEGIN);
  const finish = existing.indexOf(END);

  if (start === -1 || finish === -1) {
    // Markers are gone — preserve whatever a human wrote by appending rather
    // than overwriting it.
    writeFileSync(full, `${DOC_PREAMBLE}${generated}\n\n${existing}`);
    return;
  }

  const before = existing.slice(0, start);
  const after = existing.slice(finish + END.length);
  writeFileSync(full, `${before}${generated}${after}`);
}

// ── Drift detection ──────────────────────────────────────────────────────────

const PENDING_MERGE_PATTERN = /\(?\s*PR pending owner merge\s*\)?|pending owner merge|awaiting merge/i;

/**
 * PROGRAM_STATE.json keeps waves as an array of `{ id, title, status }`, where
 * an id may be composite ("16.0+16.1"). Parsing that structure — rather than
 * regexing the serialized blob — is what makes this reliable.
 *
 * Returns every wave whose status still claims it is awaiting merge although
 * git shows it merged. That exact discrepancy is what sent the previous session
 * to redo shipped work.
 */
function findStaleWaveStatuses(state, ref = null) {
  const programState = ref
    ? readJsonAtRef(".claude/axis-redesign/PROGRAM_STATE.json", ref)
    : readJson(".claude/axis-redesign/PROGRAM_STATE.json");
  if (!programState || !Array.isArray(programState.waves)) return [];

  const byWave = new Map(state.waves.map((wave) => [wave.wave, wave]));
  const stale = [];

  for (const entry of programState.waves) {
    if (typeof entry?.id !== "string" || typeof entry?.status !== "string") continue;
    if (!PENDING_MERGE_PATTERN.test(entry.status)) continue;

    const parts = entry.id.split("+").map((part) => part.trim());
    const merged = parts.map((part) => byWave.get(part)).filter(Boolean);
    if (merged.length === 0) continue;

    const mergedAs = merged
      .map((wave) => `Wave ${wave.wave} (${prLabel(wave.mergedPr)}, ${wave.sha})`)
      .join(" and ");
    stale.push({ id: entry.id, status: entry.status, mergedAs, merged });
  }

  return stale;
}

function generatedBlock(text) {
  const start = text.indexOf(BEGIN);
  const finish = text.indexOf(END);
  if (start === -1 || finish === -1 || finish < start) return null;
  return text.slice(start, finish + END.length);
}

function firstGeneratedDifference(actual, expected) {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const count = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < count; index += 1) {
    if (actualLines[index] === expectedLines[index]) continue;
    const wanted = expectedLines[index] ?? "<no line>";
    const found = actualLines[index] ?? "<no line>";
    return `line ${index + 1}: expected ${JSON.stringify(wanted)}, found ${JSON.stringify(found)}`;
  }
  return "unknown difference";
}

/**
 * Fails when a checkpoint doc asserts something git contradicts. Deliberately
 * narrow: it only flags claims that are provably false, so it stays trustworthy
 * and does not train anyone to ignore it.
 */
function detectDrift(state, checkTarget, previous) {
  const problems = [];
  const mergedWaves = new Set(state.waves.map((wave) => wave.wave));

  if (!previous) {
    problems.push(`${GENERATED_JSON} is missing or invalid. Run: npm run state:derive`);
  }

  for (const stale of findStaleWaveStatuses(state, checkTarget)) {
    problems.push(
      `PROGRAM_STATE.json describes wave "${stale.id}" as "${stale.status}", but ${stale.mergedAs} is merged.`,
    );
  }

  const continuation = path.join(REPO, ".prompts/vector/VE-CONTINUE-CLAUDE.md");
  if (existsSync(continuation)) {
    const text = readFileSync(continuation, "utf8");
    const nextMatch = text.match(/##\s*Next execution:\s*(?:Wave|Phase)\s*(\d+\.\d+)/i);
    if (nextMatch && mergedWaves.has(nextMatch[1])) {
      problems.push(
        `VE-CONTINUE-CLAUDE.md directs the next session to Wave ${nextMatch[1]}, which is already merged.`,
      );
    }
  }

  const canonical = path.join(REPO, CANONICAL_DOC);
  if (!existsSync(canonical)) {
    problems.push(`${CANONICAL_DOC} is missing. Run: npm run state:derive`);
  } else {
    const text = readFileSync(canonical, "utf8");
    const generated = generatedBlock(text);
    if (!generated) {
      problems.push(`${CANONICAL_DOC} is missing generated-state markers. Run: npm run state:derive`);
      return problems;
    }
    const expected = renderMarkdown(state);
    if (generated !== expected) {
      problems.push(
        `${CANONICAL_DOC} generated block differs from the deterministic state for ${git("rev-parse", checkTarget).slice(0, 8)} (${firstGeneratedDifference(generated, expected)}). Run: npm run state:derive`,
      );
    }
  }

  return problems;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const checkTarget = CHECK_ONLY ? resolveCheckTargetRef() : "HEAD";
const previous = CHECK_ONLY
  ? readJsonAtRef(GENERATED_JSON, checkTarget)
  : readJson(GENERATED_JSON);
const state = deriveState(previous, checkTarget);

if (CHECK_ONLY) {
  const problems = detectDrift(state, checkTarget, previous);
  if (problems.length > 0) {
    console.error("Checkpoint documentation contradicts the repository:\n");
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error("\nRun `npm run state:derive` and commit the result.");
    process.exit(1);
  }
  console.log("✓ Checkpoint documentation agrees with the repository.");
  process.exit(0);
}

writeFileSync(path.join(REPO, GENERATED_JSON), `${JSON.stringify(state, null, 2)}\n`);
writeCanonicalDoc(state);

console.log(`✓ Wrote ${GENERATED_JSON}`);
console.log(`✓ Wrote ${CANONICAL_DOC}`);
console.log(`  branch ${state.git.branch} @ ${state.git.head.slice(0, 8)}`);
console.log(`  ${state.waves.length} wave(s) merged, ${state.defects.open} open defect(s)`);
if (!state.gates.measured) console.log("  gates not measured this run (use --gates)");
