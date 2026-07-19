# Claude continuation context — AXIS VECTOR Arcade + Envoys

You are continuing the owner-authorized AXIS System Redesign program on
`main` — the sole canonical branch. Convergence is complete: PR #195 (phase9
redesign base), PR #239 (VECTOR Wave 15.2 arcade platform), PR #237/#238
(migration-filename drift reconciliation to prod), and the rescue-stack
kernel extractions #240–#249 are all merged. There is no separate
`codex/vector-phase15-convergence` branch to work from any longer — branch off
`main` for the next wave. The portable, tracked sources of truth are
`AGENTS.md`, `docs/axis-redesign/15-vector-arcade-and-envoys.md`,
`docs/vector/PLAN.md`, `docs/axis-redesign/15.2-convergence-execution-log.md`,
`docs/axis-redesign/15.2-lifecycle-invariant-matrix.md`,
`docs/axis-redesign/15.2-migration-reconciliation.md`,
`docs/axis-redesign/15-completion-matrix.md`,
`.claude/axis-redesign/PROGRAM_STATE.json`, and
`.claude/axis-redesign/DEFECT_LEDGER.json` — read these before editing. The
owner explicitly authorized the cross-module redesign override and accepted
all recommended premortem mitigations. Preserve the financial safety kernel,
owner/RLS boundaries, no-secret/no-PII rules, visible failures, and truthful
local-only/blocked states.

## Objective

Deliver the full dependency-ordered VECTOR Arcade + Axis Envoys program as
complete vertical slices. Do not present a game, worker, hosted deployment,
score, install, sync, or generation result as real until its own evidence
exists. The binding order is Wave 15.2 platform (done), 15.3 Second Sense
(done, PR pending owner merge — see checkpoint below), 15.4 Envoy core,
15.5 starter hatch-pet packages, 15.6 generation control plane, 15.7 vendored
worker/OpenAI/Render, then games 15.8–15.15 in the plan, and 15.16 final
cross-game/production convergence.

**Binding-order amendment (owner-authorized, recorded 2026-07-18):** Phase 16
(Archive Bay — a user-owned local emulator/native-port launcher, desktop-only)
runs as an explicitly authorized track PARALLEL to this 15.x sequence, not
strictly after it. It touches no web bundle, no shared schema, no cloud
service, and none of the 9 `VectorGameSlug` entries, so it neither blocks nor
is blocked by Second Sense or later 15.x waves. Only Phase 16.2+ (distributing
a managed emulator runtime) is gated — on Phase 16.0's licensing ADR, not on
15.x progress. See `.claude/axis-redesign/PROGRAM_STATE.json` ->
`binding_order_amendment` for the full record.

## Current checkpoint (2026-07-18)

Wave 15.2 is implemented, converged, **and merged to main** (PR #239,
2026-07-17):

- `/vector` and `/vector/[game]` Instrument Deck shell; nine catalog entries
  are visibly planned/disabled and no engine is in the lobby bundle.
- Typed registry/loaders, runtime lifecycle host, owner-partitioned Dexie
  persistence, checksum/migration quarantine, local CAS, cloud CAS/conflicts,
  bounded authenticated API/RLS migration, protocol-v3 offline worker, modal
  focus safety, shell auth-loading states, and scoped bootstrap fanout.
- Migration `202607170001_vector_arcade_persistence` (6 `game_*` tables, RLS
  on, 3 RPCs: `sync_vector_save` / `apply_vector_event` /
  `resolve_vector_conflict`) is **applied to hosted Supabase**
  (`twkcvyhmlguipchfetge`) and was verified by a rolled-back live round-trip
  including conflict create+resolve.
- All 89 repo-tracked migration files match prod's 89 recorded versions
  (`supabase db push --dry-run` clean) — the pre-July filename drift and the
  `202607161401` task/approval privilege-contract migration were reconciled
  and applied via PR #237/#238.
- GitHub CI run `29659456809` on `main@a8c7be32` passed all three jobs
  (`verify`, `e2e-smoke`, `e2e-authenticated` — the latter is the
  fresh-Supabase authenticated Playwright suite including the VECTOR arcade
  spec). This closes the prior "browser gate NOT GREEN" blocker.

Wave 15.3 (Second Sense) **merged to main** as PR #251 (`294dae37`). The
facts below are historical. Its bespoke visual layer was subsequently stripped
at the owner's direction (injected stylesheet + canvas dial renderer removed;
rules, scoring, seeding, input reducer, testids and the accessibility contract
retained) so the design can be rebuilt by a separate agent.

**Do not restate merge state in this file.** `docs/CURRENT_STATE.md` is derived
from git by `scripts/derive-program-state.mjs` and is authoritative. Read it
first; where it disagrees with anything here, it wins.

- Second Sense is the first complete, "available" VECTOR title: native
  DOM/Canvas, five hidden-timer reproduction trials, absolute + proportional
  error scoring (`src/lib/vector/games/second-sense/scoring.ts`), Easy/Hard
  difficulty, one normalized keyboard/pointer/touch hold-state machine
  (`inputState.ts`), a deterministic UTC-day-seeded daily challenge plus a
  fresh-random-seed practice mode (`rng.ts`), and local+cloud-synced personal
  best via new optional `recordScore`/`getBestScore` capabilities added to
  `VectorGameCreateContext` (`types.ts`) — both call the pre-existing
  `enqueueEvent`/`loadProfile` persistence path, no schema/migration change.
- Offline install now genuinely works end-to-end: `config/vector-offline-packages.json`
  flips `second-sense` to `enabled`; a new esbuild step
  (`scripts/build-vector-offline-bootstrap.mjs`, wired into `postbuild`
  before the manifest generator) bundles the SAME framework-free game engine
  into a standalone `public/vector-assets/offline/second-sense.js` referenced
  by a hand-authored offline HTML shell — verified against a real production
  build (5-asset, 285,952-byte manifest; the VECTOR offline package gate now
  reports "1 enabled game(s)", up from 0).
- Local gates on this branch: `npx tsc --noEmit` clean, `npm run lint` 0
  errors/0 warnings, `npm run test` 1299 passed / 191 files, `npm run build`
  175 pages, 187/187 route budgets pass, aggregate static JS **4341/4400 KB
  (98.7%)** — budget headroom is now VERY tight; the next game's chunk may
  need a deliberate, evidenced budget raise or further code-splitting first.
- `tests/e2e/vector-authenticated.spec.ts` was updated to match (Second
  Sense's lobby card and route now assert `data-game-status="available"`
  instead of `"planned"`, and the runtime is expected to actually mount) but
  this could **NOT be executed in this environment** (no local Supabase
  stack). The exact-head GitHub `e2e-authenticated` CI job on this PR is the
  real gate — check it before treating Wave 15.3 as fully closed, and be
  ready to adjust selectors if it fails (the edit was reasoned through, not
  observed running).

## Hosted gate truth (owner-only, unchanged by this checkpoint)

- **Sentry**: release is registered, but the available token receives HTTP
  403 on the Issues/dashboard query. Repository owner or a Sentry
  administrator must record the final result.
- **Render**: no worker deployed yet — implementation is Wave 15.7.
- **OpenAI paid generation**: gated on Wave 15.6/15.7 (generation control
  plane + vendored worker), not yet built; also needs explicit owner
  authorization for paid usage.
- **Manual hardware WebAuthn ceremony**: needs a human with a real
  authenticator.
- **Live Gmail/Outlook/Make provider parity**: needs owner-side live
  credentials.
- **Vercel preview on the exact current SHA**: re-verify per deploy; do not
  infer a pass from an earlier SHA's evidence.
- **Tembo role decision** and **leaked-password protection decision**: both
  remain open owner decisions, not implementation blockers.

Never infer a hosted pass from local Docker, data-plane REST, GitHub
deployment metadata, source-map upload scope, or a local Next build. Do not
mutate production or invoke paid OpenAI generation without explicit
in-session owner authorization.

## Next execution: see docs/CURRENT_STATE.md

This section previously hard-coded "Wave 15.4 Envoy core" and survived long
after 15.4 shipped, 15.5 shipped, and Envoys was removed again — sending
resuming sessions to redo finished work. Naming a specific next wave in a
static file is what caused that, so this file no longer does it.

Run `npm run state:derive` and read `docs/CURRENT_STATE.md` for what is merged
and what is only on a branch. `npm run state:check` fails if any checkpoint doc
contradicts git.

Standing context that is NOT derivable, and still applies:

- Waves 15.4 (Envoy core) and 15.5 (hatch-pet packages) merged and were then
  **removed entirely** at the owner's direction; the design is being rebuilt by
  a separate agent. Do not re-implement them from the plan below without
  checking with the owner first.
- The historical Envoy requirements are retained below for whoever rebuilds
  them (source lines noted in the completion matrix):

1. Envoy appearance independent of Focus/Intel/Ask; preserve context, privacy,
   error handling, Sentry reporting, focus management, Escape, and abort
   behavior; a status-first panel.
2. Feature-split into a dynamic `EnvoyHost`, with safe legacy mapping and
   show/hide/`activeEnvoyId` state; remove the old Mascot component only
   after parity is proven, not before.
3. Original anthropomorphic, non-robot starter designs; every hatch state and
   artifact represented.
4. Deterministic, truthful mapping of every task/routine/approval state to
   what the Envoy displays — real fields and counts, deep links to the
   actual task/run/approval/result (never a generic chat), multi-task
   priority ordering, realtime or bounded polling.
5. Low-rate idle animation; pauses when hidden or a game is running; no
   stutter, layout shift, or memory leak; reduced motion respected.
6. Interface Studio gets only a quick picker; full management lives in a
   dedicated Envoy Lab surface.
7. A prompt + "Surprise Me" + structured seeded brief + explicit confirmation
   flow for generation requests — this wave defines the UX and the
   deterministic randomizer/seed contract, NOT live paid generation (that is
   gated to Wave 15.6/15.7 behind explicit owner authorization for OpenAI
   spend).

This wave's own binding acceptance, adversarial review, and exact test/build
evidence must be produced the same way Wave 15.3's was — inspect current
Mascot/EnvoyHost code first, add the smallest real vertical slice, extend
shared contracts only additively, test unit/route/browser paths, and update
the completion matrix, program state, defect ledger, and this file before
committing.

## Required working pattern

- Inspect current files and explain current/expected behavior before edits.
- Keep provider/data logic in adapters/services; route handlers authenticate
  and derive ownership server-side.
- Never log tokens, cookies, email bodies, raw OAuth payloads, private game
  state, or OpenAI content. Capture only safe provider/operation/status/error
  metadata.
- Run `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, SQL
  replay/RLS/grant checks, bundle/route budgets, and relevant Playwright. If a
  hosted credential is unavailable, record `BLOCKED` with exact check and
  owner.
- One branch/commit per checkpoint. Push and open a PR freely; do **not**
  merge to `main` without explicit owner approval in the session — merging
  is the production deploy path (Vercel native Git integration, no separate
  `deploy.yml`).
- End each wave with changed-file inventory, database/Supabase/Tembo impact,
  Vercel/Sentry status, tests, manual checklist, risks, and the next
  dependency.

## Handoff facts

Head/branch/merge facts are no longer recorded here — they went stale five
merges in a row. `docs/CURRENT_STATE.md` carries them, derived from git.

This file previously assumed a `codex/vector-phase15-convergence` working
branch and a machine-local owner-brief attachment (`~/.codex/attachments/...`);
both are gone — do not look for either.

Do NOT push, merge, or apply any hosted migration without explicit owner
authorization in the session.
