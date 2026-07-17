# Wave 15.2 — Shared VECTOR platform

- Date: 2026-07-17
- Branch: `codex/vector-arcade-envoys`
- Status: checkpoint-ready — Wave 15.2 code and local evidence are push-ready.
  Production schema application, hosted behavior, and Sentry ingestion/review are
  unverified and explicitly `BLOCKED`.
- Parent: `0753eada924eafeb19cee3e5068f997d78871e2a` (Wave 15.1)
- Implementation spec: `.prompts/vector/VE-WAVE-15.2-PLATFORM.md`

## Invariant

Later games receive one truthful, owner-partitioned, offline-first platform.
No game is presented as playable, installed, synchronized, or complete before
its own vertical-slice wave passes. Local gameplay writes never wait for the
network, and no account can read or mutate another owner's local or cloud state.

## Delivered

- `/vector` in Labs navigation and the command palette;
- responsive Instrument Deck lobby and `/vector/[game]` detail shell;
- all nine catalog entries present, visibly `Planned`, and disabled;
- serializable metadata registry separated from client-only dynamic loaders;
- runtime controller/host with hydrate, start, pause, visibility/pagehide
  suspension, bounded autosave, checkpoint/restart/reset, context-loss handling,
  owner-transition finalization, input capture, and idempotent disposal;
- fixed-step scheduling with elapsed-time clamp and resolved motion, audio,
  control, low-power, and gamepad settings;
- one Dexie/IndexedDB database with owner-scoped `profiles`, `saves`, `outbox`,
  `conflicts`, `installs`, and `meta`; no game save uses `localStorage`;
- anonymous/device ownership, account isolation, sign-out fencing, and explicit
  anonymous-data adoption or decline;
- checksum verification, local expected-ancestor compare-and-set, migration
  quarantine/retry, immutable idempotent outbox events, monotonic counters,
  per-field setting clocks, and explicit two-branch conflict resolution;
- authenticated, rate-limited `/api/vector/bootstrap`, `/api/vector/sync`, and
  `/api/vector/conflicts/[id]` boundaries with session-derived ownership,
  bounded Zod contracts, safe errors, and service-role-only mutation RPCs;
- additive six-table cloud-schema code, locally applied with owner RLS, exact grants, payload checks,
  immutable request fingerprints, atomic save CAS, persisted conflict branches,
  and selected-branch conflict-resolution authority;
- protocol-v3 root worker, minimal offline document, generated build map, and
  allowlist-only staged install/remove/status flow with digest and size checks;
- visible loading, local-only, pending, conflict, error, unavailable, quota,
  adoption, migration, and offline-package states;
- keyboard-contained busy-safe shared modals, trigger restoration, reduced
  motion, mobile layout, light theme inheritance, and working platform utility
  controls;
- fixed telemetry allowlist that accepts controlled enums only and never save
  payloads, seeds, user identifiers, slot names, or arbitrary strings.

Not delivered or claimed:

- a playable game, game engine dependency, score, achievement, progress, or
  installed package;
- Second Sense or any later title;
- Envoy runtime, Envoy Lab, generation worker, Render deployment, or OpenAI job;
- hosted Supabase migration, Vercel preview validation, Sentry review, or
  production completion.

## Complete changed-file inventory

Program and documentation:

- `.claude/axis-redesign/PROGRAM_STATE.json`
- `.claude/axis-redesign/DEFECT_LEDGER.json`
- `.logs/vector-envoys/INDEX.md`
- `.logs/vector-envoys/wave-15.2-platform.md`
- `.prompts/vector/VE-WAVE-15.2-PLATFORM.md`
- `.prompts/vector/VE-CONTINUE-CLAUDE.md`
- `docs/axis-redesign/13-final-verification.md`
- `docs/axis-redesign/15-vector-arcade-and-envoys.md`
- `docs/axis-redesign/15-completion-matrix.md`
- `docs/production-readiness.md`
- `docs/vector/OFFLINE_PACKAGES.md`
- `docs/vector/PLAN.md`

Navigation and route shell:

- `src/app/vector/page.tsx`
- `src/app/vector/[game]/page.tsx`
- `src/app/vector/[game]/not-found.tsx`
- `src/app/layout.tsx`
- `src/components/layout/AppShell.tsx`
- `src/components/nav/ProfileSection.tsx`
- `src/components/nav/Sidebar.tsx`
- `src/components/nav/command-palette-model.test.ts`
- `src/lib/auth/getAppOrigin.ts`
- `src/lib/auth/getAppOrigin.test.ts`
- `src/lib/security/platform-shell.test.ts`
- `src/lib/icons/nav-icons.ts`
- `src/lib/store/nav.ts`
- `src/middleware.ts`
- `tests/e2e/smoke.spec.ts`

VECTOR UI and runtime integration:

- `src/components/vector/GameRuntimeHost.tsx`
- `src/components/vector/Vector.module.css`
- `src/components/vector/VectorAdoptionModal.tsx`
- `src/components/vector/VectorArtworkPlate.tsx`
- `src/components/vector/VectorConflictModal.tsx`
- `src/components/vector/VectorConflictModal.test.ts`
- `src/components/vector/VectorGamePlatform.tsx`
- `src/components/vector/VectorGamePlatformLazy.tsx`
- `src/components/vector/VectorGameShell.tsx`
- `src/components/vector/VectorLobbyModule.tsx`
- `src/components/vector/VectorLobbyPlatform.tsx`
- `src/components/vector/VectorLobbyPlatformLazy.tsx`
- `src/components/vector/VectorSyncBadge.tsx`
- `src/components/ui/Icon.tsx`
- `src/components/ui/Modal.tsx`
- `src/hooks/useVectorOffline.ts`
- `src/hooks/useVectorPlatform.ts`
- `src/hooks/useVectorPlatform.test.ts`
- `tests/e2e/vector-authenticated.spec.ts`

VECTOR domain:

- `src/lib/vector/checksum.ts`
- `src/lib/vector/checksum.test.ts`
- `src/lib/vector/contracts.ts`
- `src/lib/vector/contracts.test.ts`
- `src/lib/vector/loaders.ts`
- `src/lib/vector/merge.ts`
- `src/lib/vector/merge.test.ts`
- `src/lib/vector/offline-deployment.ts`
- `src/lib/vector/offline-deployment.test.ts`
- `src/lib/vector/offline.ts`
- `src/lib/vector/offline.test.ts`
- `src/lib/vector/offline-artifacts.test.ts`
- `src/lib/vector/offline-generator.test.ts`
- `src/lib/vector/persistence-types.ts`
- `src/lib/vector/persistence.ts`
- `src/lib/vector/persistence.test.ts`
- `src/lib/vector/public-artifacts.ts`
- `src/lib/vector/public-artifacts.test.ts`
- `src/lib/vector/registry.ts`
- `src/lib/vector/registry.test.ts`
- `src/lib/vector/runtime.ts`
- `src/lib/vector/runtime.test.ts`
- `src/lib/vector/server.ts`
- `src/lib/vector/server.test.ts`
- `src/lib/vector/sync.ts`
- `src/lib/vector/sync.test.ts`
- `src/lib/vector/types.ts`
- `src/lib/vector/view-model.ts`
- `src/lib/vector/view-model.test.ts`

Offline packaging and dependencies:

- `config/vector-offline-packages.json`
- `next.config.ts`
- `package.json`
- `package-lock.json`
- `public/sw.js`
- `public/vector-offline.html`
- `public/vector-assets/manifests/build-map.json`
- `scripts/generate-vector-offline-manifests.mjs`

Cloud persistence:

- `src/app/api/vector/bootstrap/route.ts`
- `src/app/api/vector/conflicts/[id]/route.ts`
- `src/app/api/vector/routes.test.ts`
- `src/app/api/vector/sync/route.ts`
- `src/lib/supabase/database.types.ts`
- `supabase/migrations/202607170001_vector_arcade_persistence.sql`
- `supabase/tests/vector_arcade_concurrency.sql`
- `supabase/tests/vector_arcade_persistence.sql`

## Architecture and security decisions

- Registry consumers see plain data only; loaders are dynamically imported only
  on an available game route. Phaser and Three.js are not dependencies in this
  wave and cannot enter the lobby bundle.
- Runtime teardown is a barrier: an owner transition waits for the last
  checkpoint and disposal. Failed checkpoints remain visible and retry on route
  exit instead of silently releasing the old namespace.
- Pointer capture belongs to the originating play surface. Window-level input
  cannot leak across a route or owner transition.
- Local saves require the exact prior local revision and checksum. Concurrent
  writers preserve the attempted branch as a conflict instead of overwriting a
  newer save.
- Sync idempotency binds a UUID to a payload hash. Reuse with different content
  is rejected locally and in SQL.
- State-bearing bootstrap reads are scoped to one game. List-only lobby reads do
  not transport private save branches.
- Cloud conflict resolution binds conflict version and the exact selected branch
  fingerprint in one atomic RPC result. A later refresh is display data, not
  mutation authority.
- Browser roles have owner-scoped `SELECT` only. All event, save, profile, and
  conflict mutations use narrow service-role RPCs from authenticated routes.
- Worker caching is positive-allowlist only. API, auth, RSC, navigation HTML,
  Supabase, opaque, third-party, signed/private, and `Set-Cookie` responses are
  rejected.
- Expected conflict/migration failures are visible warnings; code routes only
  unexpected failures to Sentry as exceptions with fixed safe metadata. Hosted
  Sentry ingestion and event review remain unverified and `BLOCKED`.

## Migration, grants, RLS, and data safety

Migration:
`supabase/migrations/202607170001_vector_arcade_persistence.sql`.

It adds:

- `game_profiles`
- `game_saves`
- `game_events`
- `game_scores`
- `game_achievements`
- `game_save_conflicts`

Every table carries or is keyed by `user_id`, has RLS enabled, exposes only an
owner `SELECT` policy to `authenticated`, grants no table authority to `anon`,
and grants mutations only to `service_role`. `sync_vector_save`,
`apply_vector_event`, and `resolve_vector_conflict` are service-role-only.
Payload, JSON shape, document size, identifier, revision, slot-count, open-
conflict, idempotency, and selected-branch checks exist at both API and database
boundaries.

Tembo remains unused; no role is inferred.

## Validation

Local checkpoint gate:

```text
focused VECTOR tests: 10/10 (`src/lib/vector/sync.test.ts`)
full Vitest: 1104/1104 across 152 files after giving the intentionally heavy
IndexedDB batch test an explicit 15-second timeout
TypeScript: clean
ESLint: 0 errors, 0 warnings
service-worker syntax and offline artifact tests: pass
local migration/RLS/grant/concurrency suites: pass
git diff --check: pass
```

The current source-complete production build passes locally: 171 static pages,
180 route budgets, and 4,236/4,400 KB total static JS. An earlier sandbox run
was blocked by DNS access to `fonts.googleapis.com`; that failed run was an
environment restriction, not a TypeScript/webpack diagnostic. The authenticated
browser matrix previously passed 6/6; a later rerun passed 4/6 and two cases
failed in the explicit owner-record error state during local Supabase Auth-to-
Postgres transport timeouts. The fail-closed UI evidence is valid; hosted preview
and post-preview Sentry validation remain `BLOCKED`. A final disposable-account
attempt reached Auth setup but could not observe the sign-in cookie; this is
recorded as local Supabase fixture instability, not a browser workflow pass.

## Validated defects and repairs

- `VEC-001` — public/offline cache rules could retain private or mutable data;
  replaced with a protocol-v3 positive allowlist, digest/size verification, and
  atomic staging promotion.
- `VEC-002` — owner/auth transitions could expose or write the prior IndexedDB
  namespace; added owner epoch, transition barrier, account partitioning, and
  explicit anonymous adoption.
- `VEC-003` — local and cloud stale writers could overwrite newer campaigns;
  added expected-ancestor local CAS, server-revision SQL CAS, one-open-conflict
  invariants, and two-branch preservation.
- `VEC-004` — corrupt or unmigratable saves could be discarded or retried
  against a newer slot; added checksum quarantine, exact ancestor authority,
  source preservation, export, discard, and explicit compatible retry.
- `VEC-005` — API/RLS/payload boundaries were incomplete; added handler auth,
  owner derivation, rate limits, bounded JSON/body/document/response contracts,
  exact policies/grants, and service-only mutation RPCs.
- `VEC-006` — offline manifests and messages lacked atomic version/digest
  binding; added protocol versioning, generated deployment maps, message
  validation, staged rollback, and build-bound manifests.
- `VEC-007` — runtime disposal, pointer capture, and final checkpoint races could
  outlive route/owner changes; added scoped capture, finalization barriers,
  retryable teardown, and idempotent resource disposal.
- `VEC-008` — telemetry could accept arbitrary identifiers or private runtime
  payloads; replaced with a fixed event/enum allowlist and safe route metadata.
- `VEC-009` — modal focus could escape or close during a destructive busy
  operation; added capture-phase containment, busy close guards, inert
  background, `aria-busy`, and trigger restoration.
- `VEC-010` — sync refresh/truncation/idempotency could falsely acknowledge or
  lose a branch; added exact result coverage, bounded scoped refresh, local
  acknowledgement checks, atomic branch fingerprints, and explicit partial
  truth.

## External production gates

Only GitHub authentication is operational in this session. All unavailable
hosted-service gates remain explicitly blocked:

| Gate | Status / missing access | Exact check | Human owner |
|---|---|---|---|
| Production Supabase | `BLOCKED` — no production management/DB/DDL authority; service-role REST is data-plane only | Apply `202607161000_lifecycle_claims.sql` then `202607170001_vector_arcade_persistence.sql`; read back migration history, schema/checks, RLS, grants, RPC ACLs; run two-user isolation, concurrent CAS, and advisor checks | Repository owner acting as Supabase project administrator |
| Vercel | `BLOCKED` — no authorized team/project session or SSO-bypass access | Validate the current-SHA branch preview build, environment parity, public/auth browser matrix, logs, and route/bundle budgets | Repository owner acting as Vercel team/release administrator |
| Sentry | `BLOCKED` — no project issue/event-read authority; upload-only scope does not qualify | Query the exact preview release, environment, and deployment window; verify no new regressions and no PII in intentional error events | Repository owner acting as Sentry project administrator |
| Render | `BLOCKED` — no credential or linked worker service; implementation is a later wave | After worker implementation, deploy the current release and verify health/capability heartbeat, lease lifecycle, logs, and one live job | Repository owner acting as Render workspace administrator |
| OpenAI | `BLOCKED` — no budget-limited worker-only project key or authorized paid-generation access | After worker implementation, run one paid generation and a separate cancellation smoke; verify private usage/cost/request records and final QA | Repository owner acting as OpenAI project administrator |

No local result, hosted data-plane response, GitHub deployment metadata, or
source-map upload permission converts one of these blockers into a pass.
Production promotion remains blocked until every applicable hosted gate passes.

## Remaining risks

- Final hosted preview, production migration/readback, and post-preview Sentry
  review remain `BLOCKED`; local source/build evidence is retained above.
- A clean full-suite rerun after the explicit heavy-test timeout is useful follow-
  up evidence, but does not alter the hosted gate state.
- Production schema, preview behavior, and post-preview telemetry remain
  unverified because the corresponding hosted authority is unavailable.
- All games remain planned, so game hydration, real checkpoint payloads,
  sustained play, engine isolation, per-game offline cold launch, and score
  semantics must be proven in their title waves.
- Physical mobile/touch/gamepad behavior remains a later game-level validation;
  this wave verifies the shared browser contracts and responsive shell only.
