# Claude continuation context — AXIS VECTOR Arcade + Envoys

You are continuing the owner-authorized AXIS System Redesign program from the
`codex/vector-arcade-envoys` branch. Read `AGENTS.md`, the portable owner brief
at `docs/axis-redesign/PROGRAM_BRIEF.md`,
`docs/axis-redesign/15-vector-arcade-and-envoys.md`, `docs/vector/PLAN.md`,
`.claude/axis-redesign/PROGRAM_STATE.json`, and the latest wave log before
editing. The owner explicitly authorized the cross-module redesign override and
accepted all recommended premortem mitigations. Preserve the financial safety
kernel, owner/RLS boundaries, no-secret/no-PII rules, visible failures, and
truthful local-only/blocked states.

`docs/axis-redesign/PROGRAM_BRIEF.md` is the repository copy of the original
owner attachment. Do not depend on any `/Users/.../.codex/attachments/...` path;
GitHub-based agents must use the committed file.

## Objective

Deliver the full dependency-ordered VECTOR Arcade + Axis Envoys program as
complete vertical slices. Do not present a game, worker, hosted deployment,
score, install, sync, or generation result as real until its own evidence exists.
The binding order is Wave 15.2 platform, 15.3 Second Sense, 15.4 Envoy core,
15.5 starter hatch-pet packages, 15.6 generation control plane, 15.7 vendored
worker/OpenAI/Render, then games 15.8–15.15 in the plan, and 15.16 final
cross-game/production convergence.

## Current checkpoint

Wave 15.2 is implemented and checkpoint-ready on `codex/vector-arcade-envoys`:

- `/vector` and `/vector/[game]` Instrument Deck shell; nine catalog entries are
  visibly planned/disabled and no engine is in the lobby bundle.
- Typed registry/loaders, runtime lifecycle host, owner-partitioned Dexie
  persistence, checksum/migration quarantine, local CAS, cloud CAS/conflicts,
  bounded authenticated API/RLS migration, protocol-v3 offline worker, modal
  focus safety, shell auth-loading states, and scoped bootstrap fanout.
- The local SQL migration and RLS/grant/concurrency suites, focused tests,
  TypeScript, lint, diff check, and prior source-complete production build have
  passed. `public/vector-assets/manifests/build-map.json` must remain the empty
  development marker until a real build generator is run.
- The full Vitest gate now passes 1,104/1,104 after the intentionally heavy
  65-event IndexedDB test received a bounded 15-second timeout.
- Browser evidence includes an earlier 6/6 authenticated VECTOR pass and a later
  4/6 pass where two cases exposed the intended fail-closed owner-record error
  state during local Supabase Auth→Postgres transport timeouts. Do not weaken
  `getUser` to `getSession` or add retries that hide the upstream error; rerun
  with a healthy local stack and retain visible error evidence if it recurs.

## Hosted gate truth

Only GitHub is operational. Production Supabase, Vercel, Sentry, Render, and
OpenAI are all explicitly `BLOCKED`, not passed. The canonical table in
`docs/axis-redesign/15-completion-matrix.md` records, for each service, the
missing access, exact validation still required, and human owner. Never infer a
hosted pass from local Docker, data-plane REST, GitHub deployment metadata,
source-map upload scope, or a local Next build. Do not mutate production or
invoke paid OpenAI generation. Tembo remains unused until its role is decided.

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
10. Route-isolated dynamic loader, bounded checkpoint/autosave, offline install,
    reconnect flush/pull/merge, refresh persistence, and visible feedback.
11. No copied Dialed branding, layout, effects, or text.

For this wave, inspect the platform contracts first, add the smallest real
engine-free game module and its loader, then add the API/RPC/event fields only if
the existing schema cannot express the deterministic score. Add migrations + RLS
review for any schema change. Test unit contracts, route ownership, local SQL,
public/auth browser flows, mobile/keyboard/touch, offline/reconnect, refresh, and
error paths. Keep every score deterministic and mark any non-authoritative value
as unverified. Update the completion matrix, program state, defect ledger, wave
log, and a new wave prompt before committing.

## Required working pattern

- Inspect current files and explain current/expected behavior before edits.
- Keep provider/data logic in adapters/services; route handlers authenticate and
  derive ownership server-side.
- Never log tokens, cookies, email bodies, raw OAuth payloads, private game
  state, or OpenAI content. Capture only safe provider/operation/status/error
  metadata.
- Run `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, SQL
  replay/RLS/grant checks, bundle/route budgets, and relevant Playwright. If a
  hosted credential is unavailable, record `BLOCKED` with exact check and owner.
- One branch/commit per checkpoint; do not merge a PR without explicit owner
  approval. Leave the PR open/draft or ready according to the owner’s request.
- End each wave with changed-file inventory, database/Supabase/Tembo impact,
  Vercel/Sentry status, tests, manual checklist, risks, and the next dependency.

## Immediate handoff facts

The current checkpoint commit base is `0753eada924eafeb19cee3e5068f997d78871e2a`.
The working tree contains the Wave 15.2 implementation and documentation edits;
verify status before staging. Keep the branch name unchanged. Push the checkpoint
and leave its PR unmerged; then begin Wave 15.3 only after the checkpoint is
reviewable and the local gates are recorded.
