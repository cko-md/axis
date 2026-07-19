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

_Derived from the repository at 2026-07-19T09:11:09.858Z. Do not hand-edit this block._

## Where the code actually is

- **Branch:** `feat/redesign-continuation-2026-07-19`
- **HEAD:** `af33e72c`
- **main:** `d8a15e7b`
- **Working tree:** has uncommitted changes

### Not yet on main (1 commit(s))

These exist only on this branch. Do not assume main contains them.

- `af33e72c` feat(axis): remove Envoys, strip Second Sense visuals, fix persistence/OAuth/desktop browser

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

- _carried forward; re-run with --gates to measure_

<!-- END GENERATED: derive-program-state -->

## Working notes

_Human- and agent-authored. Safe to edit. Keep it short and current; delete what
is no longer true rather than appending._

