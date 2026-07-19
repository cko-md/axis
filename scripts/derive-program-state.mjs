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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Resolve the mainline ref.
 *
 * On a CI pull-request checkout there is no local `main` branch — only
 * `origin/main` — so hard-coding "main" makes every derivation throw in exactly
 * the environment where the drift check matters most.
 */
function resolveMainRef() {
  for (const candidate of ["main", "origin/main", "refs/remotes/origin/main"]) {
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
  // Detached or shallow with no mainline available: fall back to HEAD so the
  // script degrades to "nothing is known to be merged" instead of crashing.
  return "HEAD";
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

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Merged PRs, read from git rather than from anyone's memory. Squash-merge
 * subjects carry the PR number, which is what makes this reliable.
 */
function deriveMergedPrs(limit = 60) {
  const log = git("log", `-${limit}`, "--format=%h%x1f%s%x1f%cI", MAIN_REF);
  const prs = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, subject, committedAt] = line.split("\x1f");
    const match = subject.match(/\(#(\d+)\)\s*$/);
    if (!match) continue;
    prs.push({
      pr: Number(match[1]),
      sha,
      subject: subject.replace(/\s*\(#\d+\)\s*$/, ""),
      committedAt,
    });
  }
  return prs;
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
    for (const match of pr.subject.matchAll(/\b(\d+\.\d+)\b/g)) {
      const id = match[1];
      if (!waves[id]) {
        waves[id] = { wave: id, mergedPr: pr.pr, sha: pr.sha, subject: pr.subject, mergedAt: pr.committedAt };
      }
    }
  }
  return Object.values(waves).sort((a, b) =>
    a.wave.localeCompare(b.wave, undefined, { numeric: true }),
  );
}

function deriveMigrations() {
  const dir = path.join(REPO, "supabase/migrations");
  if (!existsSync(dir)) return { count: 0, latest: null };
  const files = execFileSync("ls", [dir], { encoding: "utf8" })
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return { count: files.length, latest: files.at(-1) ?? null };
}

function deriveDefects() {
  const ledger = readJson(".claude/axis-redesign/DEFECT_LEDGER.json");
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

/**
 * Gate figures require actually running the gates, so they are opt-in. When not
 * run, the previous values are carried forward and explicitly marked stale
 * rather than silently presented as current — an unmeasured number claiming to
 * be current is exactly the failure this script exists to prevent.
 */
function deriveGates(previous) {
  if (!WITH_GATES) {
    const carried = previous?.gates ?? null;
    return carried
      ? { ...carried, measured: false, note: "carried forward; re-run with --gates to measure" }
      : { measured: false, note: "never measured; run with --gates" };
  }

  const gates = { measured: true, measuredAt: new Date().toISOString() };

  try {
    const out = execFileSync("npx", ["vitest", "run", "--reporter=json"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    // testResults is one entry per FILE. numTotalTestSuites counts describe
    // blocks (478 vs 193 here) and reporting it as a file count would put a
    // wrong number in the canonical doc — the exact failure this script exists
    // to prevent.
    gates.tests = {
      passed: parsed.numPassedTests,
      total: parsed.numTotalTests,
      files: Array.isArray(parsed.testResults) ? parsed.testResults.length : undefined,
      suites: parsed.numTotalTestSuites,
    };
  } catch (error) {
    gates.tests = { error: String(error.message ?? error).slice(0, 200) };
  }

  try {
    const bundle = execFileSync("node", ["scripts/check-bundle-budget.mjs"], { cwd: REPO, encoding: "utf8" });
    const match = bundle.match(/(\d+)\s*KB\s*\/\s*(\d+)\s*KB/);
    if (match) gates.bundleKb = { used: Number(match[1]), budget: Number(match[2]) };
  } catch {
    gates.bundleKb = null;
  }

  return gates;
}

function deriveState(previous) {
  const prs = deriveMergedPrs();
  const head = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const mainHead = git("rev-parse", MAIN_REF);
  const workingTreeClean = git("status", "--porcelain") === "";

  // Commits on this branch that main does not have. This is precisely the
  // information a resuming agent needs and the thing prose always gets wrong.
  let aheadOfMain = [];
  if (branch !== "main") {
    const ahead = git("log", `${MAIN_REF}..HEAD`, "--format=%h%x1f%s");
    aheadOfMain = ahead
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha, subject };
      });
  }

  return {
    $schema: "derived — do not hand-edit; run scripts/derive-program-state.mjs",
    derivedAt: new Date().toISOString(),
    git: { branch, head, mainHead, workingTreeClean, aheadOfMain },
    mergedPrs: prs.slice(0, 25),
    waves: deriveWaves(prs),
    migrations: deriveMigrations(),
    defects: deriveDefects(),
    gates: deriveGates(previous),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMarkdown(state) {
  const lines = [];
  lines.push(BEGIN);
  lines.push("");
  lines.push(`_Derived from the repository at ${state.derivedAt}. Do not hand-edit this block._`);
  lines.push("");
  lines.push("## Where the code actually is");
  lines.push("");
  lines.push(`- **Branch:** \`${state.git.branch}\``);
  lines.push(`- **HEAD:** \`${state.git.head.slice(0, 8)}\``);
  lines.push(`- **main:** \`${state.git.mainHead.slice(0, 8)}\``);
  lines.push(`- **Working tree:** ${state.git.workingTreeClean ? "clean" : "has uncommitted changes"}`);

  if (state.git.aheadOfMain.length > 0) {
    lines.push("");
    lines.push(`### Not yet on main (${state.git.aheadOfMain.length} commit(s))`);
    lines.push("");
    lines.push("These exist only on this branch. Do not assume main contains them.");
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
      lines.push(`| ${wave.wave} | #${wave.mergedPr} | \`${wave.sha}\` | ${wave.subject} |`);
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
  if (state.gates.measured) {
    if (state.gates.tests?.total) {
      lines.push(`- **Tests:** ${state.gates.tests.passed}/${state.gates.tests.total} across ${state.gates.tests.files} files`);
    }
    if (state.gates.bundleKb) {
      lines.push(`- **Bundle:** ${state.gates.bundleKb.used} KB / ${state.gates.bundleKb.budget} KB`);
    }
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
function findStaleWaveStatuses(state) {
  const programState = readJson(".claude/axis-redesign/PROGRAM_STATE.json");
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
      .map((wave) => `Wave ${wave.wave} (PR #${wave.mergedPr}, ${wave.sha})`)
      .join(" and ");
    stale.push({ id: entry.id, status: entry.status, mergedAs, merged });
  }

  return stale;
}

/**
 * Rewrites only the false "pending merge" claim, leaving the rest of the human
 * status prose intact. Narrow on purpose: this file carries a lot of authored
 * narrative that must survive.
 */
function correctWaveStatuses(state) {
  const relativePath = ".claude/axis-redesign/PROGRAM_STATE.json";
  const stale = findStaleWaveStatuses(state);
  if (stale.length === 0) return [];

  const full = path.join(REPO, relativePath);
  const programState = JSON.parse(readFileSync(full, "utf8"));
  const staleById = new Map(stale.map((item) => [item.id, item]));
  const corrected = [];

  for (const entry of programState.waves) {
    const match = staleById.get(entry?.id);
    if (!match) continue;
    // A composite id ("16.0+16.1") usually lands in ONE PR, so dedupe by PR
    // rather than repeating the same merge fact per sub-wave.
    const byPr = new Map(match.merged.map((wave) => [wave.mergedPr, wave]));
    const mergeFact = [...byPr.values()]
      .map((wave) => `merged to main via PR #${wave.mergedPr} (${wave.sha})`)
      .join("; ");
    // Remove the false claim, tidy what it leaves behind, then append the fact.
    const remainder = entry.status
      .replace(PENDING_MERGE_PATTERN, "")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[;,\s]+$/, "")
      .trim();
    const next = remainder ? `${remainder}; ${mergeFact}` : mergeFact;
    corrected.push({ id: entry.id, from: entry.status, to: next });
    entry.status = next;
  }

  programState.revision_reviewed = state.git.head;
  programState.derived_state_note =
    `Wave merge status is verified by scripts/derive-program-state.mjs against git. `
    + `See ${CANONICAL_DOC} for the authoritative derived view.`;

  writeFileSync(full, `${JSON.stringify(programState, null, 2)}\n`);
  return corrected;
}

/**
 * Fails when a checkpoint doc asserts something git contradicts. Deliberately
 * narrow: it only flags claims that are provably false, so it stays trustworthy
 * and does not train anyone to ignore it.
 */
function detectDrift(state) {
  const problems = [];
  const mergedWaves = new Set(state.waves.map((wave) => wave.wave));

  for (const stale of findStaleWaveStatuses(state)) {
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
    for (const wave of state.waves) {
      if (!text.includes(`| ${wave.wave} |`)) {
        problems.push(
          `${CANONICAL_DOC} does not list merged Wave ${wave.wave} (PR #${wave.mergedPr}). Run: npm run state:derive`,
        );
      }
    }
    // Deliberately NOT an equality check. Every commit moves HEAD, so requiring
    // an exact match would fail on literally every pull request and train
    // everyone to ignore this job — which is how the docs rotted in the first
    // place. What actually matters is whether the recorded commit still belongs
    // to this history; a doc one commit behind is fine, a doc pointing at a
    // commit that no longer exists here is genuinely stale.
    const headMatch = text.match(/\*\*HEAD:\*\*\s*`([0-9a-f]+)`/);
    if (headMatch && !state.git.head.startsWith(headMatch[1])) {
      let isAncestor = false;
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", headMatch[1], state.git.head], {
          cwd: REPO,
          stdio: "ignore",
        });
        isAncestor = true;
      } catch {
        isAncestor = false;
      }
      if (!isAncestor) {
        problems.push(
          `${CANONICAL_DOC} records HEAD ${headMatch[1]}, which is not an ancestor of ${state.git.head.slice(0, 8)}. Run: npm run state:derive`,
        );
      }
    }
  }

  return problems;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const previous = readJson(GENERATED_JSON);
const state = deriveState(previous);

if (CHECK_ONLY) {
  const problems = detectDrift(state);
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

const corrected = correctWaveStatuses(state);
for (const item of corrected) {
  console.log(`✓ Corrected wave ${item.id}: no longer claims pending merge`);
}

console.log(`✓ Wrote ${GENERATED_JSON}`);
console.log(`✓ Wrote ${CANONICAL_DOC}`);
console.log(`  branch ${state.git.branch} @ ${state.git.head.slice(0, 8)}`);
console.log(`  ${state.waves.length} wave(s) merged, ${state.defects.open} open defect(s)`);
if (!state.gates.measured) console.log("  gates not measured this run (use --gates)");
