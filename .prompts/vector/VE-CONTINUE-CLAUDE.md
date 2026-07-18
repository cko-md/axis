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
exists. The binding order is Wave 15.2 platform (done), 15.3 Second Sense,
15.4 Envoy core, 15.5 starter hatch-pet packages, 15.6 generation control
plane, 15.7 vendored worker/OpenAI/Render, then games 15.8–15.15 in the plan,
and 15.16 final cross-game/production convergence.

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
2026-07-17). Live surface on `main` (head `a8c7be32` at last checkpoint —
verify the exact current head before starting):

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
- Local gates on the merged head: `npx tsc --noEmit` clean, `npm run lint` 0
  errors/0 warnings, `npm run test` 1265 passed / 187 files,
  `npm run build` 175 pages, 187/187 route budgets pass, aggregate static JS
  4322/4400 KB (98.2% — budget headroom is tight; watch this on the next
  route addition). Postbuild VECTOR offline-manifest generator correctly
  emits 0 enabled games (all 9 titles remain planned/disabled).
- GitHub CI run `29659456809` on `main@a8c7be32` passed all three jobs
  (`verify`, `e2e-smoke`, `e2e-authenticated` — the latter is the
  fresh-Supabase authenticated Playwright suite including the VECTOR arcade
  spec). This closes the prior "browser gate NOT GREEN" blocker.

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

## Next execution: Wave 15.3 Second Sense

Implement the first real game as a complete vertical slice before any later
game. Use native DOM/Canvas only; do not add Phaser or Three.js. Requirements
from `docs/vector/PLAN.md`:

1. Five hidden-timer reproductions from memory.
2. Absolute and proportional error scoring.
3. Easy and Hard modes.
4. Responsive press-and-hold or start/stop interaction.
5. Restrained, satisfying timing feedback with reduced-motion support.
6. Solo mode and deterministic daily challenge.
7. Local best and cloud-synced best using the shared platform contracts.
8. Keyboard, pointer, and touch input with accessible focus and 44px targets.
9. Explicit loading, local-only, pending, synced, conflict, error, quota, and
   unavailable states; no fake scores or global ranking claims.
10. Route-isolated dynamic loader, bounded checkpoint/autosave, offline
    install, reconnect flush/pull/merge, refresh persistence, and visible
    feedback.
11. No copied Dialed branding, layout, effects, or text.

For this wave, inspect the platform contracts first, add the smallest real
engine-free game module and its loader, then add API/RPC/event fields only if
the existing schema cannot express the deterministic score (score mode e.g.
`"daily"` with `challengeId=day-key`, `"practice"` without). Add migrations +
RLS review for any schema change. Test unit contracts, route ownership, local
SQL, public/auth browser flows, mobile/keyboard/touch, offline/reconnect,
refresh, and error paths. Keep every score deterministic and mark any
non-authoritative value as unverified. Update the completion matrix, program
state, defect ledger, and this file before committing.

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

## Handoff facts (2026-07-18 checkpoint repair)

`main@a8c7be32` is the last-verified head at the time of this checkpoint
repair — re-verify with `git fetch origin && git log --oneline -1
origin/main` before starting new work, since further PRs may have merged
since. This file previously assumed a `codex/vector-phase15-convergence`
working branch and a machine-local owner-brief attachment
(`~/.codex/attachments/...`); both are gone — do not look for either. The
tracked docs listed at the top of this file are the sole source of truth.

Do NOT push, merge, or apply any hosted migration without explicit owner
authorization in the session. Begin Wave 15.3 (Second Sense) from a fresh
branch off `main`.
