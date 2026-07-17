# VE-WAVE-15.2 — Shared VECTOR platform

## Objective

Ship the complete shared platform that later VECTOR games will use: typed
registry/loaders, route-isolated runtime lifecycle, owner-partitioned IndexedDB
storage, deterministic merge/sync contracts, additive owner-RLS cloud schema and
authenticated APIs, allowlist-only offline installation, and the responsive
Instrument Deck lobby/detail shell. Do not implement or imply a playable game
in this wave.

## Read first

- `AGENTS.md`
- `docs/vector/PLAN.md`
- `docs/axis-redesign/15-vector-arcade-and-envoys.md`
- `docs/axis-redesign/adr/0004-vector-runtime-and-engine-isolation.md`
- `docs/axis-redesign/adr/0005-offline-save-sync-and-cache-boundary.md`
- `.logs/vector-envoys/design-review.md`
- `src/lib/store/nav.ts`
- `src/components/layout/AppShell.tsx`
- `src/components/nav/command-palette-model.ts`
- `src/app/globals.css`
- `src/middleware.ts`
- `next.config.ts`
- `src/lib/supabase/{server,admin,database.types}.ts`
- the latest migrations under `supabase/migrations/`
- `scripts/check-{bundle-budget,perf-budgets}.mjs`
- `playwright.config.ts` and relevant `tests/e2e/*.spec.ts`

## Deliverables

1. `/vector` in Labs navigation and the command palette.
2. `/vector` Instrument Deck lobby with:
   - featured planned-game detail;
   - honest planned/disabled library cards for all nine catalog entries;
   - empty Continue/conflict state backed by real local data;
   - working volume, reduced-motion, controls, storage, sync-health, and
     fullscreen utilities;
   - explicit loading, unavailable, quota, local-only, pending, conflict, and
     error states.
3. `/vector/[game]` detail/runtime route with missing, unsupported, planned, and
   load-failure handling. No engine or game code in the lobby bundle.
4. Serializable registry metadata separated from client-only loaders. Registry
   validation rejects duplicate/bad manifests and enabled games without a
   loader.
5. Shared runtime contract/controller/host covering hydrate, start, pause,
   resume, bounded autosave, restart/reset, visibility/pagehide suspension,
   error reporting, and idempotent disposal.
6. One typed IndexedDB database with owner-scoped `profiles`, `saves`, `outbox`,
   `conflicts`, `installs`, and `meta` stores. No game save in `localStorage`.
7. Pure merge/migration/checksum contracts for best score, achievements,
   counters, settings, campaign revision conflicts, and corrupt-save
   preservation.
8. Additive Supabase migration for `game_profiles`, `game_saves`,
   `game_events`, `game_scores`, and `game_achievements`, with owner RLS,
   payload limits, idempotency, service-only mutation authority, and atomic
   save compare-and-set.
9. Authenticated `/api/vector/bootstrap` and `/api/vector/sync` routes deriving
   ownership from the session, validating payloads with Zod, enforcing byte
   limits, failing visibly, and returning partial/conflict truth explicitly.
10. Root `/sw.js`, minimal offline document, safe registration/client, and
    per-game staging/install/remove/status protocol. The worker may cache only
    declared same-origin immutable Next chunks, public `/vector-assets/`, and
    the offline document; never APIs, auth, RSC, navigation HTML, Supabase,
    private/signed assets, `Set-Cookie`, or opaque responses.
11. Unit/route/browser coverage and measured `/vector` bundle/performance
    budgets.

## Binding constraints

- No Phaser, Three.js, PixiJS, or overlapping engine dependency in this wave.
- No fake playable, installed, online, synced, progress, score, achievement, or
  cloud state.
- Planned games are labelled and disabled until their own complete wave lands.
- Gameplay/local writes never wait for network.
- Sign-out freezes the prior owner namespace; another account cannot read it.
- Anonymous-save adoption is explicit, never automatic across accounts.
- Never silently discard a newer or corrupt local save.
- Every visible control works or is visibly disabled with the exact reason.
- Preserve Axis themes, density, focus, 44px touch targets, reduced motion, and
  light mode.
- No production migration/deploy/provider mutation. Hosted Supabase, Vercel,
  Sentry, Render, and OpenAI gates stay explicitly `BLOCKED` without authorized
  credentials.
- Implementation agents edit only; they do not commit or push.

## Required tests

- Registry validation, missing/planned/enabled loader behavior.
- Runtime state transitions, pause/resume, visibility suspension, autosave
  bounds, load failure, and idempotent disposal.
- Owner partitioning, local save/outbox/conflict lifecycle, settings, sign-out,
  anonymous merge decision, corrupt-save quarantine, and quota failures.
- Merge rules, duplicate idempotency, revision conflict, schema migration.
- API auth, body/row limits, owner derivation, save CAS conflict, event
  deduplication, score max, achievement union, partial failure, and visible
  service-unavailable errors.
- Migration first apply/replay, RLS owner isolation, exact grants/RPC ACLs,
  payload checks, idempotency, and concurrent save CAS.
- Service-worker allowlist/rejection, staging rollback, install/remove/status,
  and no API/auth/navigation caching.
- Playwright: desktop/mobile lobby, keyboard focus, every utility, planned-game
  detail, IndexedDB refresh recovery, quota/error state, reduced motion, and no
  console errors.
- `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, public
  and authenticated Playwright, bundle and route budgets.

## Required report

Return:

- invariant;
- complete changed-file inventory;
- architecture and security decisions;
- migration/RLS/grant evidence;
- local/browser/performance test evidence;
- validated defects and repairs;
- hosted blockers;
- remaining risks.

Every hosted blocker record must state the missing access, the exact validation
that remains to run, and the human owner authorized to run it. No local result,
historical hosted evidence, GitHub metadata, data-plane response, or upload-only
scope may be treated as a hosted pass.
