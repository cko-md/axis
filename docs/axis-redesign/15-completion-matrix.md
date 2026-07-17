# Phase 15 completion matrix

- Status: open
- Source brief: 2,241-line owner attachment, SHA-256
  `ab7dccf6d91c88941273b4975dee00ba1c89c8295f3587cd7e2cf66593057cd9`
- Rule: `complete` requires direct evidence in named path; code presence alone is
  insufficient
- Status vocabulary: `open | partial | complete`; hosted gates use uppercase
  `BLOCKED` so local evidence cannot be mistaken for production readiness

## Program controls

| Requirement | Source lines | Status | Required evidence |
|---|---:|---|---|
| Owner-authorized cross-module scope; safety, privacy, financial kernel, migrations/RLS, observability, production gates retained | 8–17 | partial | Branch/governance record plus final safety audit |
| Sequential waves; orchestrator owns architecture and final verification; no concurrent worktree edits/builds | 19–22, 43–57 | partial | Per-wave agent/log/commit history and independent gates |
| Requested GPT-5.6 Sol Ultra runtime | 40–41 | open | Runtime metadata if exposed; otherwise honest unverifiable note |
| All 32 ground-truth sources and concurrent PR/history inspected before edits | 63–101 | partial | Recon and merge logs |
| Required architecture/plans/log/prompt artifacts; state and defect update after every wave | 103–113 | partial | Files plus per-wave diffs |
| Required skills verified/read/used in order | 119–182 | partial | `skill-preflight.md`; hatch, Playwright, and OpenAI-doc evidence in later waves |
| Axis theme/accent/surface/radius/type/density/motion inherited; forbidden slop/fake data/copying absent | 188–228 | open | Theme matrix, originality review, browser/accessibility evidence |

## Preimplementation design

| Requirement | Source lines | Status | Evidence |
|---|---:|---|---|
| Three lobby concepts, two card systems, selected console, cover direction | 1888–1892 | complete | `design-review.md`, VECTOR prompt/manifest, concept PNG |
| Envoy concept sheet, HUD concepts, Envoy Lab concept | 1893–1895 | complete | Envoy prompts/manifests, two concept PNGs |
| Mobile and light adaptations | 1896–1897 | partial | Concepts complete; real browser views open |
| Named visual/UX/game/premium/anti-slop/motion/accessibility reviews | 165–168, 1899–1918 | partial | Wave 15.0 synthesis complete; implementation review open |
| Reusable prompts saved; no AI-baked product copy in shipped assets | 302–306, 780–784 | partial | Prompt manifests complete; final covers/starters open |

## Wave 15.1 integration and lifecycle safety

| Requirement | Status | Evidence |
|---|---|---|
| Preserve Phase 9 redesign foundations while integrating current `origin/main` and patch-equivalent `c2de9308` without a stacked dependency | complete | Two-parent merge sealed from `960d20f4` and `a029cd58392a75497113685b9363c4f3e617f672`; patch provenance recorded without importing unrelated ancestry |
| Versioned preference envelope, timezone/unknown-field preservation, failed-read no-write, no hydration echo, account/CAS fencing, visible retry/incompatible state | complete | `src/lib/theme/interface-preferences.ts`, `ThemeProvider.tsx`, drawer UI, and focused tests |
| Atomic owner-scoped task transitions and stale approval decisions | complete | `transition_agent_task`, route compare-and-set tests, and local SQL transaction probes |
| Atomic task creation and routine provenance; claimed work requires owner/routine/live-token/lease match | complete | `create_agent_task`, `taskPersistence.ts`, route/executor tests, and SQL old-token/quarantine probes |
| Fenced approval/routine claim, renewable heartbeat, claim-fenced step/task writes, finalize/release/repause, lost-response recovery | complete | Lifecycle migration, route/executor tests, and local SQL transaction probes |
| Stale-worker recovery invalidates the old token, quarantines for operator review, and cannot be bypassed by generic retry | complete | `runState.ts`, executor/concentration route tests, trigger/RPC SQL probes |
| Passkey/session authority: exact ceremony, one-time consumption, counter CAS, zero browser policies/grants, no stored refresh token/token exchange | complete | Passkey routes, deleted token route, authority tests, migration ACL/readback |
| Real passkey registration → sign-out → fresh session → authenticated API browser flow | complete | `tests/e2e/passkey-authenticated.spec.ts`; virtual CTAP2 platform authenticator 1/1 and three inspected screenshots |
| Local migration first-apply/replay, exact grants, browser denial, owner isolation, provenance/quarantine, and duplicate-link preflight | complete | `.logs/vector-envoys/wave-15.1-integration-safety.md` |
| Migration is atomic when the duplicate-link preflight fails | complete | Explicit `BEGIN/COMMIT`, CI boundary guard, and forced local failure preserving pre-migration ACL/data state |
| Hosted Supabase migration/application/readback | BLOCKED | See canonical hosted-gate table below; local Docker and data-plane responses do not satisfy production DDL/readback |
| Vercel preview workflow | BLOCKED | See canonical hosted-gate table below; GitHub deployment metadata does not satisfy preview access |
| Post-preview Sentry regression review | BLOCKED | See canonical hosted-gate table below; source-map upload scope does not satisfy issue/event review |
| Render worker deployment and validation | BLOCKED | See canonical hosted-gate table below; worker implementation is a later wave |
| Paid OpenAI live generation and provider-backed validation | BLOCKED | See canonical hosted-gate table below; worker implementation is a later wave |

## Canonical hosted-service gates

Only GitHub is operational for gate execution. Production promotion remains
`BLOCKED`; local tests, historical hosted evidence, GitHub deployment metadata,
data-plane responses, and source-map upload permission cannot satisfy these
gates.

| Gate | Status / missing access | Exact check | Human owner |
|---|---|---|---|
| Production Supabase | `BLOCKED` — no production management/DB/DDL authority; service-role REST is data-plane only | Apply `202607161000_lifecycle_claims.sql` then `202607170001_vector_arcade_persistence.sql`; read back migration history, schema/checks, RLS, grants, RPC ACLs; run two-user isolation, concurrent CAS, and advisor checks | Repository owner acting as Supabase project administrator |
| Vercel | `BLOCKED` — no authorized team/project session or SSO-bypass access | Validate the current-SHA branch preview build, environment parity, public/auth browser matrix, logs, and route/bundle budgets | Repository owner acting as Vercel team/release administrator |
| Sentry | `BLOCKED` — no project issue/event-read authority; upload-only scope does not qualify | Query the exact preview release, environment, and deployment window; verify no new regressions and no PII in intentional error events | Repository owner acting as Sentry project administrator |
| Render | `BLOCKED` — no credential or linked worker service; implementation is a later wave | After worker implementation, deploy the current release and verify health/capability heartbeat, lease lifecycle, logs, and one live job | Repository owner acting as Render workspace administrator |
| OpenAI | `BLOCKED` — no budget-limited worker-only project key or authorized paid-generation access | After worker implementation, run one paid generation and a separate cancellation smoke; verify private usage/cost/request records and final QA | Repository owner acting as OpenAI project administrator |

## VECTOR platform

| Requirement | Source lines | Status | Evidence needed |
|---|---:|---|---|
| `/vector`, `/vector/[game]`, Labs nav, typed registry, runtime, persistence/sync, shared pause/settings/controls/audio/offline UI | 234–251 | partial | Wave 15.2 implementation, focused/full unit evidence, typecheck, lint, local SQL, and source-complete build evidence are recorded in `.logs/vector-envoys/wave-15.2-platform.md`; hosted preview remains `BLOCKED` |
| Lobby featured actions, library metadata, Continue/pending/conflict rail, utility controls, detail view; every control works | 253–306 | partial | Truthful planned lobby and authenticated browser evidence exist; two rerun cases exposed local Supabase transport instability through the visible fail-closed state |
| Complete manifest fields, lifecycle, private-safe events, dynamic chunks, justified/measured engines | 308–360 | partial | Registry/runtime/telemetry/disposal tests and local bundle evidence exist; no engine is installed in this platform wave; real game cold launch remains Wave 15.3 |
| Binding game order and one complete game before next | 582–599 | open | Sequential wave commits/logs |

Full title contracts are preserved in `docs/vector/PLAN.md` under **Binding
title-specific acceptance**. Completion remains open for:

1. Second Sense (source 367–391)
2. Brickrise, including mandatory Phaser (413–430)
3. Time to Fly (431–453)
4. Paper Glider (455–477)
5. Envoy Arena (479–504)
6. Phantasy Axis (529–552)
7. Biome Lab (506–527)
8. MiniTown (554–580)
9. Neon Rift (393–411)
10. cross-game controller/offline/achievement polish (595–596)

Each title needs its separate wave commit, game-specific unit coverage, final
mechanic cover, interactive play log, mobile/desktop evidence, offline/save/sync,
console-error capture, sustained-play trace, and disposal proof.

## Offline-first save and sync

| Requirement | Source lines | Status | Evidence needed |
|---|---:|---|---|
| Network-independent gameplay; typed IndexedDB, versioned snapshots/outbox/idempotency/device/game/save versions/revisions/checksum/timestamps/sync state; no save localStorage | 605–625 | partial | Owner-partitioned Dexie repository and offline tests exist; first real game integration remains Wave 15.3 |
| Save on checkpoints, completion, bounded interval, pause, visibilitychange, pagehide; not beforeunload-only | 627–635 | partial | Shared runtime lifecycle and finalization-barrier tests exist; real-game checkpoint proof remains Wave 15.3 |
| Additive owner-RLS schema; Zod and payload limits; compact seed+deltas | 637–652 | partial | Local migration, generated types, API/RLS/grant/concurrency tests exist; production Supabase application/readback is explicitly blocked |
| Type-specific deterministic merge; preserve both campaigns and original failed migrations; never discard newer local | 654–670 | partial | Pure merge, local/cloud CAS, conflict, corruption, and migration-quarantine tests/UI exist; real-game migration proof remains open |
| Per-game offline install for shell/chunk/fonts/cover/assets/minimal route; estimate/install/update/remove/quota/pending UI | 672–692 | partial | Protocol-v3 worker/generator/deployment tests and UI exist; cold launch of an enabled game remains Wave 15.3 |
| Reconnect flush/pull/merge with honest Synced/Pending/Conflict/Error/Local Only | 693–697 | partial | Sync orchestrator and partial/truncation/owner-change tests exist; final browser network-transition rerun is pending |

## Envoy core

| Requirement | Source lines | Status | Evidence needed |
|---|---:|---|---|
| Appearance independent of Focus/Intel/Ask; preserve context/privacy/errors/Sentry/focus/Escape/abort; status-first panel | 703–736 | open | Parity unit/browser matrix |
| Feature split, dynamic EnvoyHost, safe legacy mapping/show-hide/activeEnvoyId; remove Mascot only after parity | 738–776 | open | Migration tests, bundles, diff/browser proof |
| Original anthropomorphic non-robot starters; all hatch states and artifacts | 778–836 | partial | Concepts complete; hatch packages/QA open |
| Deterministic truthful mapping of every task state; real fields/counts; approvals/results links; multi-task priority; realtime or bounded polling | 838–900 | open | Adapter/state tests, deep links, browser/API load |
| Low-rate idle, hidden/game pause, no stutter/shift/leak, reduced motion | 902–923 | open | CPU/memory/visibility traces |
| Interface Studio quick picker only; Envoy Lab full management | 925–952 | open | Desktop/mobile interaction evidence |
| Prompt + Surprise Me + structured seeded brief + confirmation; quota/cost/cancel/moderation/privacy/RLS/signed URLs/limits | 954–987 | open | UX, deterministic randomizer, security/rate tests |

## Production Envoy generation

| Requirement | Source lines | Status | Evidence needed |
|---|---:|---|---|
| Browser → Vercel → auth API → Supabase jobs/private inputs → Render worker → OpenAI + pinned hatch-pet → private Storage → events/Realtime; forbidden substitutes absent | 993–1077 | open | Deployed graph and live records |
| Pinned upstream sync/vendor/UPSTREAM/license/SHA manifest/CI drift; real deterministic scripts | 1080–1129 | open | Vendor commit/hash and CI |
| Dedicated TS worker, Node 24, Python/Pillow/WebP, Render blueprint, claim/lease/heartbeat/events/cancel/upload/release/crash recovery/retries | 1131–1191 | open | Container tests, Render service/logs |
| Jobs, monotonic events, Envoys, assets, atomic claim, service-only leases, private short signed assets, cross-user isolation | 1194–1275 | open | Applied schema/RPC/grant/RLS/Storage matrix |
| Pure state machine; transition before expensive work; truthful queued/active/retry/wait/cancel/fail/complete; percent only from known units | 1278–1333 | open | Transition tests and real job timeline |
| Official OpenAI SDK, worker-only key, current docs, canonical base + referenced edits, persisted prompts as private data | 1335–1379 | open | Official-doc decision log, code, integration tests |
| API-safe grids; one pose/cell; deterministic extraction/key/192×208/baseline/horizontal rows | 1382–1431 | open | Fixture/hash/order/alpha tests |
| Deterministic validators + structured vision QA; deterministic result wins; retry failed stage only; no partial Envoy | 1433–1488 | open | Validator/QA/exhaustion/retry tests |
| Private reference/intermediate/QA/final paths; runtime asset subset; retention and retryable cleanup; never public bucket | 1491–1523 | open | Storage policies, expiry, cleanup evidence |
| All named auth CRUD/job/capability routes; generate validates capability/limits/owner/idempotency and returns 202 | 1525–1563 | open | Route/latency/stale-heartbeat tests |
| Document web/worker env; no public secrets; heartbeat disables stale worker; production provider/migration/storage/live load/refresh/Sentry | 1565–1610 | open | Deploy config and live evidence |
| Four-step persistent UX; close/navigate/reopen/other-device; all state previews; metadata-only Realtime | 1613–1659 | open | Multi-session/device browser evidence |
| Input/decompression/URL limits; per-user rate, one active, daily allowance, max cost; safe usage/request IDs/logs | 1662–1695 | open | Abuse/quota-race/privacy tests |
| Every named unit/integration test; full fixture pipeline; fixture impossible in production; no live CI credits | 1698–1739 | open | Test inventory and production guard |
| Paid live OpenAI job and separate cancel job; browser-close survival; stages; validation; private render/select/sync; no Sentry regression | 1741–1754 | open | Timestamped live smoke log |
| Threat model for listed attacks; fixed command/state allowlists; spawn/execFile arrays; prompt is data | 1757–1786 | open | Threat model, search, adversarial tests |
| One pinned skill/state machine/artifact/validation path; no desktop/developer/Codex UI dependency | 1789–1809 | open | Architecture/deployment audit |
| Full production completion gate | 1812–1843 | open | Every preceding row complete |

## Data, review, testing, performance, release

| Requirement | Source lines | Status | Evidence needed |
|---|---:|---|---|
| Avoid duplicate schema; additive/order/RLS/owner/service-only/private/size/cleanup/forward-fix/types/tests | 1849–1875 | open | Schema inspection and applied-target audit |
| Shared scores server-validated or labelled unverified personal | 1876–1879 | open | API/UI trust label tests |
| No OpenAI, service-role, GitHub, or provider secret in browser | 1881–1882 | open | Build/env/network/secret scan |
| Full per-wave inspect/spec/implementation/review/browser/adversarial/repair/independent-gate/update/commit loop | 1924–2006 | partial | Every wave log/commit |
| Typecheck, lint, unit each code wave; build for runtime/route/assets; relevant public/auth e2e | 2012–2025 | partial | Wave 15.1 local commands/counts recorded; every later code wave remains open |
| Full platform test matrix | 2027–2039 | open | Named tests |
| Full persistence test matrix | 2040–2052 | open | Named tests |
| Every game start/control/score/fail/restart/pause/hydrate/seed/collision/console/mobile/sustained and QA log | 2054–2095 | open | Per-game evidence |
| Full Envoy state/parity/job/private/a11y/route/CPU matrix | 2068–2083 | open | Named tests/traces |
| Preserve budgets; no lobby engines; dynamic game chunks; compressed assets; no leaks; `/command` unaffected; measure JS/tasks/FPS/memory/CPU/IDB/sync/cache | 2098–2127 | open | Build/network/performance logs |
| VECTOR definition of done | 2133–2148 | open | All VECTOR rows complete |
| Envoy definition of done | 2150–2166 | open | All Envoy rows complete |
| Program gates: type/lint/test/build/e2e/perf/migration/RLS/preview/Sentry/docs/state/draft PR/risks | 2168–2185 | partial | Wave 15.1 local gates complete; unavailable hosted Supabase/Vercel/Sentry/Render/OpenAI gates are explicitly blocked, while later-wave/final implementation gates remain open |
| Final report includes all 19 named sections and conceals no incomplete work | 2191–2213 | open | Final handoff |

## Easy-to-miss binding facts

- Envoy Arena needs eight original selectable Envoys; four initial seeds alone
  are insufficient.
- Neon Rift is last in build order despite appearing second in catalog.
- A feature flag cannot substitute for deployed worker completion.
- Official OpenAI docs must be consulted immediately before worker image/vision
  implementation even though `openai-docs` appears last in overall skill order.
- Every lobby control works; decorative switches fail.
- Game titles/copy stay DOM text.
- Offline installation is per-game; sign-in merge and sign-out isolation are
  tested behaviors.
- Campaign conflicts preserve both branches; failed migrators preserve source.
- Envoy clicks open exact task/run/approval/result, not generic chat.
- Percent requires a true denominator.
- Private assets and diagnostics never enter public buckets or Realtime blobs.
- CI fixture provider must be production-impossible; separate paid live smoke is
  mandatory.
- `/command` bundle impact is part of VECTOR performance acceptance.
- Screenshots/build success do not replace interactive play.
