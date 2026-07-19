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

_Derived from the repository at 2026-07-19T14:20:03.494Z. Do not hand-edit this block._

## Where the code actually is

- **Branch:** `main`
- **HEAD:** `a89c4d66`
- **main:** `a89c4d66`
- **Working tree:** clean

## Waves merged to main

| Wave | PR | Commit | Subject |
| --- | --- | --- | --- |
| 15.3 | #251 | `294dae37` | feat(vector): ship Second Sense, the first complete VECTOR title (Wave 15.3) |
| 15.4 | #254 | `e122413a` | feat(envoys): Wave 15.4 Envoy core — headroom recovery, identity domain, truthful HUD, Envoy Lab |
| 15.5 | #255 | `2ba9fd8f` | feat(envoys): Wave 15.5 starter hatch-pet packages — validated original art, derived status, hatch UX |
| 16.0 | #253 | `61e833d4` | feat(archive-bay): Phase 16.0 ADR + 16.1 bring-your-own-emulator launcher |
| 16.1 | #253 | `61e833d4` | feat(archive-bay): Phase 16.0 ADR + 16.1 bring-your-own-emulator launcher |
| 16.2 | #256 | `d8a15e7b` | feat(archive-bay): managed melonDS runtime (Phase 16.2, ADR-0005 Option B) |

Every row above is **merged**. A wave listed here is done; do not restart it.

## Database

- **Tracked migrations:** 89
- **Latest:** `202607170001_vector_arcade_persistence.sql`

## Defects

- **Total logged:** 29
- **Open:** 0

## Gates

- **Tests:** 1408/1408 across 199 files
- **Bundle:** 4245 KB / 4400 KB
- **Measured at:** 2026-07-19T14:20:03.510Z

<!-- END GENERATED: derive-program-state -->

## Working notes

_Human- and agent-authored. Safe to edit. Keep it short and current; delete what
is no longer true rather than appending._

### Next up: Wave 15.8 Brickrise — Phaser scene wiring

The mechanical core is DONE and on main: `src/lib/vector/games/brickrise/`
contains `physics.ts`, `level.ts`, `progress.ts`, `inputState.ts` — all pure,
DOM-free, 55 tests. Phaser 3.90 is installed but not yet imported anywhere.

**One blocker stands between here and a playable Brickrise**, and it is a build
problem, not a game problem:

`scripts/check-bundle-budget.mjs` partitions route-isolated game chunks out of
the shared budget by FILENAME — `<game-slug>.*.js` and the declared engine
vendor names `vector-engine-phaser` / `vector-engine-three`. Importing Phaser
under `/* webpackChunkName: "vector-engine-phaser" */` does not produce that
name: Next's own `lib` cacheGroup (priority 30, 8-hex hashed names) claims it
into an anonymous ~1164 kB vendor chunk, which then counts against the SHARED
budget and takes it to 5409/4400 kB.

Already tried and ruled out: mutating
`config.optimization.splitChunks.cacheGroups` inside the `webpack()` hook in
`next.config.ts`, at priority 40 and 100, with `chunks: "async"` and
`chunks: "all"`, `enforce: true`. The hook runs and `splitChunks` is a mutable
object (`chunks`, `cacheGroups`, `maxInitialRequests`, `minSize`; existing
groups are `framework` p40 and `lib` p30) — but no `vector-engine-*` chunk is
ever emitted, so the mutation is not reaching the client compiler. Suspect
`withSentryConfig` wrapping, or Next 15 rebuilding the client optimization
config after the user hook.

Worth trying next: a small custom webpack plugin that renames the chunk at
`compilation` time; or Next's `experimental.turbopack`/webpack config surface
rather than the `webpack()` escape hatch; or teaching the budget script to
resolve the engine chunk from the build manifest's dependency graph instead of
by filename (less brittle than either).

**Do not raise the budget to make this pass.** The partition caught a genuinely
misfiled 1.1 MB chunk — that is the gate working, not obstructing.

The scene code itself was written and typechecked clean before being reverted;
reconstruct from `physics.ts`/`level.ts`/`progress.ts`/`inputState.ts`, which
are the whole rule set. Keep the split strict: Phaser draws, `stepBody` decides.
Arcade physics is deliberately unused.

**Registry stays `planned`** until the design agent delivers sprites and
lighting; flipping to `available` without art trips `AVAILABLE_WITHOUT_ARTWORK`.
A loader on a planned game is valid.

### Then: 15.9 Time to Fly, 15.10 Paper Glider

Same core-first pattern: pure deterministic modules with heavy tests, design
left as a seam. 15.10 uses Three (~356 kB) rather than Phaser (~1168 kB), so it
may be the better first target once chunk naming is solved. See
`wave_order_revision` in PROGRAM_STATE.json — 15.6 skipped, 15.7 deferred,
15.11 blocked on the Envoy redesign.

