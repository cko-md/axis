# Current state

**Read this file first.** It is the single canonical entry point for any agent or
tool resuming work on this repository — Claude Code, Codex, Cursor, or a human.

The block below is generated from the repository by
`scripts/derive-program-state.mjs`. It is the authority on what is merged, what
is only on a branch, and what the gates last measured. Where any other document
disagrees with it, this file wins and the other document is stale.

Narrative context that cannot be derived — intent, owner decisions, what to do
next and why — lives in the sections *after* the generated block and is written
by humans and agents. Never hand-edit inside the generated markers; run:

```
npm run state:derive          # refresh
npm run state:check           # fail if any checkpoint doc contradicts reality
```

<!-- BEGIN GENERATED: derive-program-state -->

_Deterministically derived from committed repository content. Do not hand-edit this block._

## Repository state identity

- **State fingerprint:** `66ce44e521697f4c059a6281af6299191d078014818c63c6b64061e53a843914` (committed tree plus bound provenance/gate evidence; only the two generated state artifacts are excluded)
- **Content tree:** `70d85c7cbf536f72b0d9123361f8b5b9e74fe72a7fa2991bfe58bb20902a6c6c`
- **Source-main tree at derivation:** `f8d84fb78236a14df8458aeaa5fdc1cccce5b7641f1d4b56d3a2a8419fed6a54`
- **Production release rule:** source-main alignment is evaluated by Vercel at deploy time; this snapshot records the derivation-time source-main tree and does not claim current alignment after a merge.
- An equivalent squash/merge preserves every rendered derived fact. A new numeric wave or other fact change requires a protected state refresh.

## Source snapshot provenance

_Informational origin of this snapshot. The fingerprint, not commit topology, establishes currency after an equivalent squash or merge._

- **Branch:** `codex/redesign-00-governance-bootstrap`
- **HEAD:** `65466993`
- **main:** `44be089b`
- **Working tree:** clean

### Ahead of source main at derivation (5 commit(s))

- `65466993` fix(state): make provenance SHA rendering deterministic
- `9bd49715` docs(state): refresh bootstrap gate evidence
- `ec709532` fix(release): freeze css build configuration
- `732f393e` docs(state): record governance bootstrap gates
- `2a6f9c18` harden(release): bootstrap trusted production controls

## Waves merged to main

| Wave | PR | Commit | Subject |
| --- | --- | --- | --- |
| 4.4 | local merge | `2a0d940d` | feat(fund): multi-currency minor-unit table + FX conversion with provenance (wave 4.4) |
| 4.5 | local merge | `6dd8f5e1` | feat(fund): tax-lot / cost-basis / corporate-actions domain (wave 4.5) |
| 4.6 | local merge | `0fc3e503` | feat(fund): populate provenance from write paths + Activity freshness badge (wave 4.6) |
| 4.7 | local merge | `cb886e1a` | feat(fund): wire holdings reconciliation to real data + surface in UI (wave 4.7) |
| 6.2 | local merge | `7487cf28` | fix(state): repair PROGRAM_STATE.json (missing/trailing comma from wave 6.2 insert) |
| 11.2 | local merge | `7c033898` | ci(perf): enforce performance budgets on the CI build (wave 11.2) |
| 12.1 | local merge | `b7053214` | test: JSON-artifact guard + authenticated Operate e2e smoke (Phase 12.1) |
| 15.2 | local merge | `64dec9cd` | docs(axis): record Wave 15.2 convergence reconciliation + execution log |
| 15.3 | #251 | `294dae37` | feat(vector): ship Second Sense, the first complete VECTOR title (Wave 15.3) |
| 15.4 | #254 | `e122413a` | feat(envoys): Wave 15.4 Envoy core — headroom recovery, identity domain, truthful HUD, Envoy Lab |
| 15.5 | #255 | `2ba9fd8f` | feat(envoys): Wave 15.5 starter hatch-pet packages — validated original art, derived status, hatch UX |
| 15.8 | local merge | `f94934d9` | feat(vector): Wave 15.8 Brickrise playable — Phaser shell, engine chunk naming, unclimbable-tower fix |
| 15.9 | local merge | `32a26c72` | feat(vector): Time to Fly deterministic flight mechanics and level progression (Wave 15.9) |
| 15.10 | local merge | `5572d3ee` | feat(vector): Wave 15.10 Paper Glider shell — Three scene, input, completability guard |
| 16.0 | #253 | `61e833d4` | feat(archive-bay): Phase 16.0 ADR + 16.1 bring-your-own-emulator launcher |
| 16.1 | #253 | `61e833d4` | feat(archive-bay): Phase 16.0 ADR + 16.1 bring-your-own-emulator launcher |
| 16.2 | #256 | `d8a15e7b` | feat(archive-bay): managed melonDS runtime (Phase 16.2, ADR-0005 Option B) |

Every row above is **merged**. A wave listed here is done; do not restart it.

## Database

- **Tracked migrations:** 91
- **Latest:** `20260722064615_user_settings_kv.sql`

## Defects

- **Total logged:** 43
- **Open:** 0

## Gates

_Local source evidence is persisted in `.claude/axis-redesign/GENERATED_STATE.json` and bound into the state fingerprint. It is not the hosted production-readiness gate. A normal derive preserves a measured pass only when the content-tree hash is identical; otherwise it marks the evidence stale. `--gates` runs typecheck, lint, the full unit suite, a clean production build, and the aggregate bundle budget._

- **Tests:** 1914/1914 across 227 files
- **Bundle:** 4287 KB / 4400 KB
- **Route-isolated game bundle:** 1964 KB / 3000 KB
- **Measured source:** `65466993`
- **Measured content tree:** `70d85c7cbf536f72b0d9123361f8b5b9e74fe72a7fa2991bfe58bb20902a6c6c`
- **Measured at:** 2026-07-23T04:46:36.041Z

<!-- END GENERATED: derive-program-state -->

## Working notes

_Human- and agent-authored. Safe to edit. Keep it short and current; delete what
is no longer true rather than appending._

### 2026-07-20 session: shutdown hardening, 15.10 spike, Brickrise repairs, PG core

Four lanes ran in parallel across isolated worktrees (a concurrent session owns
Wave 15.9 on `feat/wave-15.9-time-to-fly` — do not duplicate it; review
findings were handed to it directly):

- **#258 merged** — desktop shutdown-dialog hardening plus two review-found P1
  repairs: the updater can no longer raise an undismissable ownerless prompt
  (no-live-window prompts skip; the menu path ensures a window), and file
  pickers route through a quit-aware `showFilePicker()`. 94/94 desktop tests,
  9/9 Electron e2e on this Mac. The Electron 43 native SEGV remains
  unreproduced and is NOT claimed fixed.
- **#259 merged** — Wave 15.10 prerequisite: `three@0.185.1`,
  `vector-engine-three` chunk proven route-isolated (717 kB, 0 of 197 route
  entries), shared bundle unchanged. `check-bundle-budget.mjs` now re-derives
  route isolation from `app-build-manifest.json` every run; engine
  single-importer guards catch static imports; the chunk classifier lives in
  `scripts/bundle-partition-core.mjs` with table-driven behavioral tests.
- **#260 open** — Brickrise shell repairs for six verified post-merge review
  findings (BRICKRISE-004/005 in the ledger: cross-source input cancellation;
  the "Best summit" HUD lying about a slower run). Registry copy made true
  (no shake/particles exist); in-band "Climb again" after the summit.
- **#261 merged** (`72f4e738`) — Paper Glider deterministic core: the
  passability oracle is checked in (25 seeds × 30+ rooms driving the real step
  function, capped-speed depths included), the opening-drift bound is derived
  from `stepGlider` at generation time, and furniture/rings are placed against
  the re-simulated trajectory. Registry stayed `planned`. The shell built on
  top of this core in a later session — see "Wave 15.10 Paper Glider" below.

Environment notes: fresh worktrees need `npm install` in `electron/` too, or
the Electron e2e times out in beforeAll (`electron-updater` lives in
`electron/package.json`). Post-deploy Sentry review COMPLETE via the `sentry`
CLI (owner installed it 2026-07-20): zero new and zero active unresolved
issues across the #258–#261 deploy window; Vercel runtime errors also zero.
The Sentry MCP connector remains invalidated — the CLI is the working path.

### Wave 15.8 Brickrise — scene wired, chunk blocker solved

Both blockers from the previous handoff are resolved. Brickrise now has a
working Phaser shell (`games/brickrise/game.ts`) driven by a pure simulation
core (`simulation.ts`), and Phaser is correctly billed to the route-isolated
budget.

**The chunk blocker was misdiagnosed.** The previous note blamed the
`webpack()` hook not reaching the client compiler, and listed cacheGroup
mutation as ruled out. Instrumentation disproved all of that: the hook runs,
the cacheGroup arrives intact at priority 50, its `test` matches
`node_modules/phaser/dist/phaser.js`, and priority is honoured. The real cause
is that **a `webpackChunkName` magic comment and a cacheGroup competing for one
name cancel each other out** — the comment pre-registers the name in
`compilation.namedChunks`, and SplitChunksPlugin's existing-chunk guard then
drops the cacheGroup entry silently. Fix: name the engine chunk *only* from
next.config.ts, and import Phaser with a plain `import("phaser")`.
`src/lib/vector/engine-chunks.test.ts` guards both halves of that pairing.
Wave 15.10 will need the same for Three; its cacheGroup is already declared
(inert until `three` is installed).

Also worth recording: the misfiled chunk was **route-isolated all along** — it
appears in 0 of 197 route entries in `app-build-manifest.json`. The 5409 KB
figure was a filename-classification artifact, not real shared weight. The
shared bundle with Phaser (4245 KB) is *below* the pre-Phaser baseline (4255 KB).
No budget was raised.

**A critical defect was found in the 15.8 mechanical core that shipped in
`29f96d0c`: the tower could not be climbed.** `JUMP_IMPULSE -11.6` yields a
peak rise of 102.78 px against a 132 px `FLOOR_SPACING` — no floor was
reachable from the one below, so checkpoint 0 was unreachable and the summit
could never fire. All 42 tests passed because they asserted floor gaps were
*equal*, never that one was *jumpable*. Fixed by `JUMP_IMPULSE -14`
(151.14 px rise, 19.14 px margin) plus a reachability test that derives the
rise from the real `stepBody` and searches generated towers. See
`BRICKRISE-001` in the defect ledger.

**Every remaining game wave should land a reachability/solvability test
alongside its generator**, before its mechanical core is called complete. Two
independently-tuned constants with nothing relating them is the defect class
here, and it is not specific to Brickrise.

Registry keeps Brickrise `planned` — mechanics and runtime are done, artwork is
not. A loader on a planned game is valid; flipping status without ready
artwork trips `AVAILABLE_WITHOUT_ARTWORK`.

**Four manifest/design questions raised by the review, now decided:**

- *No fall death or kill plane.* The subtitle promised a mechanic that does not
  exist — `level.ts` walls the tower, gives the ground floor full width, and
  emits only spike hazards, so there is no way to lose, only to lose time.
  **Decision: make the copy true, not the game bigger.** Subtitle is now
  "Every fall costs time, never progress," which is exactly what checkpoints +
  a fastest-summit score produce. A rising hazard remains an open design
  direction; it would be a mechanic change belonging in `level.ts`/`progress.ts`
  with tests, not a copy patch, and nothing depends on it.
- *Summit floor also fired a checkpoint.* Floor 24 satisfies the interval, so
  the run's final step emitted checkpoint and summit together and the summit
  announcement was clobbered. **Decision: do not generate it.** A checkpoint on
  the summit can never be respawned to, so it was dead state. Towers now carry
  5 checkpoints, and a test asserts none sits on the summit ledge.
- *`score.achievements: true` with no achievement defined.* **Decision: false.**
  Nothing defines a Brickrise achievement and the event sanitiser drops string
  `achievementId` values, so the flag claimed a capability that ships in no
  form. Second Sense — the only complete title — also sets it false.
- *`save.deterministicSeed: false` while generation is seeded.* **Decision:
  keep false; the review's suggestion to flip it was wrong.** Generation is
  fully deterministic, but the *seed* is a fresh random UUID per run. Second
  Sense sets this true because its daily challenge derives the seed from the
  UTC day; Brickrise has no shared-tower mode, so no two players are promised
  the same climb. `reset()` re-rolling the tower is consistent with that: a
  restart is a new climb, and the personal best is a best-across-runs, which is
  what `personal-unverified` already signals.

### Wave 15.10 Paper Glider — shell built over the merged core

Built in an isolated worktree (`feat/vector-15.10-paper-glider-shell`, off
`origin/main @ 42ee761b`) on top of the mechanical core `#261` merged earlier
the same day. `game.ts` is now the full Three-facing shell, not the 15.10
engine-isolation skeleton the file used to be: bounded/pruned room scene graph
(1 room behind + 3 ahead of the glider, so an endless flight cannot accrete
GPU geometry), a chase camera, an honest HUD (score/distance/rings/speed/
status/result/best-flight), keyboard+pointer+touch steering through a shared
reducer (`inputState.ts`, new), and dispose/context-loss handling that forces
`WEBGL_lose_context` on teardown (same reasoning as Brickrise: this component
remounts on every runtime retry, and browsers cap live WebGL contexts). Input
binds to `context.mount` — not the game's own root — because binding to the
wrong element is exactly what made Brickrise unplayable by keyboard
(`BRICKRISE-002`).

**The completability guard** (`completability.test.ts`, new — Paper Glider's
analogue of Brickrise's reachability test and Time to Fly's solvability
sweep): a static audit that every generated doorway sits inside the
physics-derived steerable envelope and the room cross-section, a tiered
dynamic pilot sweep (broad/standard/deep/fuzz, up to 1,500 arithmetically
derived seeds) that flies the *real* `stepPaperGliderSimulation` through real
generated levels one fixed step at a time, and falsification fixtures proving
the detector actually fires on hand-built un-flyable levels. Its own header
records a manual falsification run: reverting the generator to the literal
Wave 15.8 defect class (a stale hand-tuned steering constant, then a removed
doorway clamp) makes 3/8 and then 4/8 of these tests fail, confirming the
guard is not vacuous.

**Building that guard found three genuine defects in the merged core**, now
in the ledger and fixed in this worktree:

- `PAPER-GLIDER-001` (high) — the merged core used `Math.hypot` on the
  authoritative simulation/generation path in three files (`physics.ts`'s
  arrive-steering distance, `level.ts`'s furniture clearance, `simulation.ts`'s
  ring-capture check), which is not guaranteed correctly-rounded across JS
  engines the way `sqrt` is — a determinism-rule violation that could
  silently desync a replay or generate a different level for the same seed
  on a different engine. Fixed to sqrt-of-squares / squared-magnitude
  comparisons; guarded going forward by a new source-scan test,
  `determinism.test.ts`.
- `PAPER-GLIDER-002` (high) — `generateFurniture`'s clearance check sampled
  the flight path only at a furniture box's *centre* z, missing intrusions
  elsewhere across the box's z-thickness during a room's steering ramp-up.
  Produced provably un-flyable levels on 8 witness seeds found by independent
  adversarial probes. Fixed by `boxClearsFlightTube()`, which sweeps the
  box's full z-extent.
- `PAPER-GLIDER-003` (medium) — the registry manifest claimed capabilities
  the shell does not have: `reducedMotionBehavior` described curtain/dust/
  loose-page effects that exist nowhere in the game, and `score.achievements`
  was `true` though no achievement is defined anywhere and the runtime
  sanitizer drops `achievementId` strings outright. Both corrected; a new
  `game.test.ts` assertion pins the honest values.

**What is true now:** the shell mounts, steers by keyboard/pointer/touch,
runs the same fixed-step simulation the completability sweep flies (no
renderer-owned animation loop, no analytic fast-forward — `game.test.ts`
source-scans for both), renders the bounded scene, and never shows fake rank/
leaderboard/achievement/player-count/install/sync language (`game.test.ts`
"no fake state"). Registry stays `planned`; every mesh, colour, and material
is placeholder geometry the file header calls out as the seam for real art.
1,820 tests pass across 223 files; `tsc`, lint, build, and both bundle budgets
(shared 4245/4400 KB, route-isolated 1964/3000 KB) are clean — see the Gates
block above once `state:derive` re-runs against this branch.

**What must land before `available`:** real artwork from the design lane
(Codex), the same externally-gated dependency Brickrise has. Flipping status
without it trips `AVAILABLE_WITHOUT_ARTWORK`.

**Rebase required before merge.** This branch forked `origin/main` at
`42ee761b`; main is contended by a concurrent session on this machine, so by
the time this branch is reviewed, main has likely moved past that commit.
Rebase onto whatever main has become — do not merge from this stale base, and
do not assume `42ee761b` is still the tip.

### Wave order

15.9 Time to Fly and 15.10's deterministic core are both merged to main
(`32a26c72`, `#261`/`72f4e738`). 15.10's shell is built and gated in the
isolated worktree above but not yet merged — rebase onto current main first
(see above). 15.6 skipped, 15.7 deferred, 15.11 blocked on the Envoy redesign
— see `wave_order_revision` in PROGRAM_STATE.json. Brickrise and Paper Glider
artwork both remain externally gated on the design lane (Codex); registry
status stays `planned` for both until art lands.

