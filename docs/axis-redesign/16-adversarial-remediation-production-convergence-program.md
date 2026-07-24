# AXIS System Redesign — Adversarial Remediation and Production Convergence Program

Repository: `cko-md/axis`  
Local path: `/Users/ogo.ko/Projects/axis`

## Mission

Act as the primary Codex program orchestrator for a broad, owner-authorized AXIS System Redesign.

Do not merely produce another plan or review. Verify the current state, then execute the program in coordinated, reversible phases until AXIS reaches production-grade maturity under the exit criteria below.

Use multi-agent delegation aggressively where work can proceed independently. Review, test, redesign, implement, debug, independently re-review, repair, validate, commit, push, open PRs, merge, deploy, and verify hosted behavior as each phase becomes complete.

Continue across turns and use durable handoffs. Do not stop after scaffolding, mock UI, or local-only success.

## Owner authorization and scope override

This prompt explicitly invokes the System Redesign Override in `AGENTS.md`.

For this program:

- Work may span modules and does not require one Linear issue per change.
- A phase may use one or more coordinated branches and PRs.
- Broad refactors are allowed when they directly implement the redesign architecture.
- Cross-module changes are allowed when they belong to the same coherent phase.
- Use branches prefixed with `codex/`.
- You are authorized to commit, push, open PRs, configure required GitHub protections, merge, deploy, apply migrations, inspect and repair production configuration, and run provider/hosted validation when safe and necessary.
- GitHub, Vercel, production Supabase, Sentry, Render, OpenAI, and configured provider access are authorized.
- Do not ask for separate permission for ordinary in-scope phase actions.

This does not waive:

- Secret, token, or private-content safety.
- Financial safety and deterministic calculation requirements.
- Migration and RLS requirements.
- Approval and step-up requirements.
- Visible failure handling.
- Hosted production-readiness gates.
- Preservation of unrelated user changes.

Do not push directly to `main` until branch protection and required checks are established. Prefer protected PR merges even though direct-write authorization exists.

## Startup rules

Before editing:

1. Read `AGENTS.md` completely.
2. Read `docs/CURRENT_STATE.md`, but do not trust it blindly.
3. Independently verify:
   - local HEAD;
   - `origin/main`;
   - worktree status;
   - GitHub PRs and checks;
   - production deployment SHA;
   - migration count and linked Supabase state;
   - current Sentry issues;
   - current dependency audit.
4. Read the canonical redesign and design sources:
   - `docs/axis-redesign/00-program-charter.md`
   - `docs/axis-redesign/01-current-state-audit.md`
   - `docs/axis-redesign/02-product-synthesis.md`
   - `docs/axis-redesign/06-design-system.md`
   - `docs/axis-redesign/15-vector-arcade-and-envoys.md`
   - `docs/design/design-reference-synthesis.md`
   - `docs/design/component-inspiration-audit.md`
   - `docs/design/liquid-iridescence-application-guide.md`
   - `docs/design/premium-dashboard-module-audit.md`
   - `docs/vector/PLAN.md`
   - `docs/DESIGN_HANDOFF.md`
5. Preserve any user-owned worktree changes.
6. Treat the audit snapshot below as a baseline, not an immutable fact. If the repository has advanced, reconcile every finding against the new code before acting.

## Audit baseline

The last adversarial review examined clean `main` and `origin/main` at:

`44be089b0c42427baa86dd9874ee16161a9252c6`

At that snapshot:

- `docs/CURRENT_STATE.md` recorded `b2a7faf1`, seven commits behind.
- It recorded 90 migrations; local and linked production had 91.
- `npm run state:check` passed incorrectly because the checker accepted any ancestor.
- No open PRs existed.
- `main` had no branch protection and no repository rulesets.
- Exact-head Vercel production was ready.
- Production deployed before required authenticated CI failed.
- The failing GitHub run was:
  `https://github.com/cko-md/axis/actions/runs/29899118328`
- The authenticated suite reported 18 passing, one deterministic selector failure, and one flaky VECTOR fetch case.
- Hosted Sentry review surfaced 26 unresolved production issues over seven days.
- Production finance notifications were failing during Make outbox encryption.
- Linked Supabase contained all 91 tracked migrations.
- Static inspection found RLS enabled on all 85 created tables, but a live anonymous/owner/other-user behavior matrix was not run.
- Tembo had no evidenced application role.
- The worktree was clean.

Local audit gates at that snapshot:

- Node 24 typecheck: passed.
- Node 24 lint: passed.
- Unit tests: 1,824/1,824 passed across 223 files.
- Production Next build: passed; 176 static pages.
- Shared bundle: 4,286 KB of a 4,400 KB budget.
- Route-isolated VECTOR game bundles: passed.
- Targeted VECTOR tests: 660 passed across 47 files.
- Targeted security tests: 162 passed.
- Desktop tests/security assertions: 144 passed.
- Signed desktop-release checks were skipped because the release workflow did not exist.
- Production dependency audit: failed with four high and one low vulnerability.
- Full dependency graph reported five high and one low.
- Four-worker public E2E passed 10/13; all three failures passed when rerun serially.
- `state:check` passed falsely against stale state.

## Executive audit verdict

AXIS has valuable foundations and should not be indiscriminately rewritten.

Preserve:

- Mail’s normalized/cache-first infrastructure.
- Durable tasks, approvals, routines, and activity records.
- The financial approval and simulation-only brokerage boundaries.
- VECTOR’s deterministic mechanics, fixed-step scheduler, lifecycle controller, IndexedDB persistence, conflict preservation, RLS/service-only sync boundary, route isolation, and offline manifest architecture.
- Electron sandboxing, origin controls, IPC gating, download validation, path containment, and Archive Bay runtime validation.
- Sentry source maps, release tags, replay masking, and central scrubbing.
- Existing design tokens and reduced-motion/transparency foundations.

The repository was not production-ready under its own contract because release governance, provider identity, network boundaries, financial truth, mutation outcomes, and several module UX/data promises were not reliable.

No confirmed unauthenticated RCE, universal auth bypass, cross-tenant database read, or enabled live brokerage execution was found.

## Program stop-lines

Treat these as P0 program blockers.

### 1. Production can deploy while CI is red

At the audit snapshot:

- `main` was unprotected.
- Vercel deployed on push to `main`.
- The production deployment completed before authenticated CI failed.
- Required checks therefore did not control production promotion.

Required result:

- Protect `main`.
- Prohibit direct pushes.
- Require docs currency, verify, public E2E, authenticated E2E, dependency audit, and preview deployment before merge.
- Ensure production follows only a protected green merge.
- Make exceptions explicit, temporary, recorded, and owner-approved.

### 2. Provider mutation timeouts create unknown outcomes

`timedProviderOperation` races a timer but does not abort the underlying provider operation.

Affected workflows include:

- Mail send/reply.
- Mail read/archive/delete.
- Calendar create.
- Calendar delete.

A timed-out request may later succeed, while the user retries and duplicates the action.

Required result:

- Typed mutation-command envelope.
- Idempotency key.
- Abort propagation.
- Durable command/receipt ledger.
- Explicit `outcome_unknown` or `reconciling` state.
- Reconcile provider state before permitting retry.
- No ordinary error toast for an unknown outcome.

### 3. Financial failures can become authoritative values

At the audit snapshot:

- Missing or failing Plaid cash could become numeric zero.
- Quote failure could become cost basis.
- Degraded values could be persisted into authoritative net-worth snapshots.
- A high-confidence briefing could be generated from incomplete data.
- Fund’s UI could persist a proposed order intent as an executed buy/sell transaction with `executed_at`.

Required result:

- Financial inputs use `fresh | stale | missing | error`.
- Unavailable is never zero.
- Provider-authoritative, manually entered, estimated, and stale values remain partitioned.
- Partial data cannot produce high-confidence output.
- Order intents are separate from immutable executions.
- Only a verified provider receipt can establish execution.
- Intent cannot affect holdings, P&L, activity, or reporting.
- Use deterministic typed money arithmetic.

## Confirmed P1 security and platform findings

Revalidate and remediate each finding.

### Direct Spotify and Strava credentials are not AXIS-user-bound

At the audit snapshot:

- Direct tokens lived in browser-wide cookies.
- OAuth callbacks validated browser state but did not bind the provider connection to the initiating AXIS user.
- AXIS sign-out cleared only Supabase.
- A second AXIS user in the same browser could inherit the first user’s provider connection.
- Spotify’s token endpoint could return the inherited access token client-side.

Required:

- Encrypted owner-scoped server credential records or intentional convergence onto a safe provider transport.
- One-time OAuth state with user ID, expiry, PKCE verifier, and consumed status.
- Provider identity binding.
- Existing-cookie migration/revocation.
- Sign-out cleanup as defense in depth.
- Cross-account isolation E2E.

### SSRF defenses are incomplete

The existing string-based URL checks did not safely cover:

- Alternate loopback addresses.
- IPv4-mapped IPv6.
- IPv6 link-local and ULA.
- Metadata and other reserved ranges.
- Redirect hops.
- DNS rebinding.

Affected paths included reader extraction, generic proxying, OG-image fetching, and RSS/background feed fetching.

Required:

- One shared `safeFetch`.
- DNS A/AAAA resolution.
- Rejection of all private, loopback, link-local, multicast, unspecified, documentation, and metadata ranges.
- Mapped IPv6 handling.
- Manual redirect processing and validation of every hop.
- Redirect, time, and body-size limits.
- DNS pinning or revalidation.
- Adversarial fixtures that prove the internal target receives zero requests.

### Integration mutations use unsafe topology

At the audit snapshot:

- Composio reconnect was an authenticated GET.
- It could delete the active connection before replacement OAuth completed.
- Strava disconnect mutated state through GET.
- A generic Composio executor accepted raw arguments for tools including mail send and move-to-trash.
- This bypassed route-specific schemas, account selection, provenance, idempotency, and action-policy approval.

Required:

- POST plus Origin/CSRF validation.
- Transactional staged replacement.
- Preserve the old connection until the new one is verified active and owner-bound.
- Repair records for partial remote/local cleanup.
- Remove the generic mutation endpoint or constrain it to read-only tools.
- Dedicated Zod-validated mutation routes with action-policy enforcement.

### Missing Supabase configuration fails open

Protected requests could proceed when required auth configuration was absent.

Required:

- Production configuration preflight.
- Protected routes return 503 when auth infrastructure is unavailable.
- Explicit public API allowlist.
- All other API routes default to authenticated.
- Sensitive routes retain local authentication/ownership checks.

### Production dependencies are vulnerable

The audit snapshot included affected versions of:

- Next.js.
- Sharp/libvips.
- Fast URI.
- Brace Expansion.
- DOMPurify.

Required:

- Upgrade and refresh the lockfile.
- Run production and full dependency audits.
- Add a required high/critical runtime audit to PR CI.
- Generate an SBOM.
- Use explicit, expiring exceptions only when remediation is impossible.
- Re-run build, typecheck, lint, unit, browser, bundle, and hosted gates.

### Production finance notification delivery is failing

Sentry recorded Make outbox encryption failures from `finance-daily`.

Required:

- Validate production encryption key presence, length, version, rotation, and intended environment.
- Fail configuration preflight visibly.
- Propagate `NotifyResult`.
- Cron results must report partial/systemic failure.
- Create an authenticated, audited replay/repair path.
- Run a real canary for every notification category without logging content.

### Additional hardening requirements

- Replace serverless process-local rate limiting with distributed quotas for cost and mutation routes.
- Add bounded fallback behavior and defined Redis-outage policy.
- Add a global trusted-device revocation epoch or server-side trusted-device records.
- Revoke remembered MFA devices after factor removal, password compromise, or security reset.
- Normalize provider errors before Sentry; never include raw upstream bodies or secrets.
- Make webhook deduplication atomic and durable.
- Use bounded background concurrency and per-user/per-stage isolation.
- Return retryable non-2xx for systemic webhook configuration/decryption failure.
- Add a signed/notarized desktop release workflow and updater rollback gate.

## Cross-module data and truth findings

Revalidate and resolve these through shared contracts where possible.

- Notes automatically inserted fabricated records into new signed-in accounts.
- Vitality automatically inserted fabricated meals and presented hardcoded nutrition as today’s data.
- Notes, Objectives, Vitality, Agenda, Spotify, and Control Room had mutations that ignored persistence failure and still announced success.
- Dispatch cross-module routing was not atomic or idempotent.
- Schedule omitted overlapping events that began before the queried range.
- Schedule created multiple local recurrence rows but synchronized only the first provider occurrence.
- Schedule quick-add included decorative, unbound controls.
- Library deleted Storage before metadata and could retain a row pointing to missing content.
- Library’s upload claims exceeded its actual progress/resume/validation behavior.
- Atelier stored base64 images in database rows without adequate type/size validation.
- Atelier could duplicate a complete lesson batch in Agenda.
- Settings reads conflated “missing” and “database error.”
- Pending synchronized settings could be discarded on unmount.
- Realtime subscriptions lacked visible connecting/stale/error state and polling recovery.
- Calendar and Contacts could convert malformed/provider-failed responses into successful empty arrays and overwrite good cache.
- The integration registry still described direct Gmail/Outlook even though actual Mail selection had converged to Composio-only.
- Calendar and Contacts still bypassed the normalized adapter contract.
- Provider and module errors were frequently converted into false empty states.
- Several destructive actions lacked confirmation or undo.
- Many legacy module controls were mouse-only or bypassed the strong shared Modal component.
- Briefing displayed static relative time, fixed media duration, and fixed read-time claims.
- Supper Club’s “Refresh Sources” only rotated static examples.
- People “merge” did not actually merge contact data.
- Control Room security loading could remain stuck after rejected requests.
- Signed-in Literature/Agenda behavior could silently degrade to device-only persistence.

Implement a shared mutation contract:

`idle → pending → confirmed`

with explicit alternatives:

- `failed_retryable`
- `failed_terminal`
- `unsynced_queued`
- `outcome_unknown`
- `reconciling`
- `partially_completed`
- `repair_required`
- `conflict`

Never display success before confirmed persistence or provider acknowledgement.

## AXIS product and visual direction

AXIS is a personal operating system, not a generic SaaS dashboard, game portal, or AI chat shell.

The core operational loop remains:

Observe → normalize → determine significance → surface signal/task → gather context → calculate deterministically → reason where appropriate → propose → approve → execute within permissions → verify → record provenance.

Use:

- Typed entities and references.
- Backlinks and previews.
- Unified search and command palette.
- Local-first responsiveness with visible freshness.
- Durable tasks, routines, approvals, skills, and costs.
- Persistent assistant identity.
- Explicit provenance, authority, and permissions.

Reject:

- Autonomous financial execution by default.
- Hidden memory.
- Chat as the canonical record.
- Blended provider data without provenance.
- LLM-authoritative financial arithmetic.
- Fake live status or progress.
- External content authorizing actions.
- Every tool being available in every context.

Visual language:

- Near-black navy foundation.
- Layered charcoal/frosted glass.
- Warm bone type.
- Restrained brass/gold or user accent.
- Marine data blue.
- Clay/gold warning.
- Muted red danger.
- Precise spacing and small radii.
- Sticky blurred topbar.
- Configurable sidebar, theme, density, typography, radius, motion, and transparency.
- Iridescence only as atmospheric depth, never universal card/button chrome.
- Reduced-motion and reduced-transparency modes remove drift, shimmer, and heavy effects.

Use a consistent signature surface: an AXIS provenance/instrument rail showing source, freshness, sync, authority, and action outcome.

## Command board requirements

The existing drag system only reorders rows and does not store pointer-derived horizontal placement. CSS auto-flow consequently collapses widgets left.

Rebuild it instead of continuing to patch the old model.

Required architecture:

- Versioned `{breakpoint, x, y, w, h, revision}` layout records.
- Pointer, touch, and keyboard movement.
- Resizing.
- Explicit collision and compaction rules.
- No silent left-packing.
- Separate desktop, tablet, and mobile arrangements.
- Revision/CAS conflict handling.
- Local-first persistence with visible `local | syncing | synced | conflict | error`.
- Unsynced retry.
- Migration from existing layout records.
- One WidgetShell interaction language.

Widget requirements:

- Typed refresh results.
- Await refresh before success.
- Per-widget loading and error.
- Visible source, last refresh, freshness, and stale state.
- Explicit retry.
- Remove double-click refresh.
- Remove dead placeholder menu items.
- Implement or truthfully disable Location.
- No nested invalid interactive controls.
- Preserve last-known data during refresh failure.

Design direction:

- Weighted command instrument canvas, not a uniform card grid.
- Refreshable widgets must feel integrated with the Command hierarchy.
- Do not visually overuse iridescence.
- Mobile becomes an intentional ordered flow rather than a compressed desktop grid.

Required tests:

- Column 1 → column 4 pointer drag.
- Row movement.
- Keyboard movement.
- Collision and resize.
- Desktop/mobile layout migration.
- Reload and cross-device persistence.
- Conflict resolution.
- Geolocation granted/denied.
- Refresh 200/401/429/500/timeout.
- No success before confirmed response.

## Listening Room / Listening Vault requirements

The current implementation is a connected lab, not a production-grade listening room.

Known issues:

- Spotify actions announced success without checking response status.
- Synthetic sine-wave bars appeared audio-reactive.
- RAF continued unnecessarily.
- “Iterate” changed a counter without changing recommendations.
- “Spotify-informed” recommendations did not actually use the claimed inputs.
- Provider failures became empty or stale UI.
- The metallic record-room framing looked like a separate product.
- Mobile behavior and keyboard access were weak.
- Direct Spotify identity was affected by the cross-account cookie defect.

Rebuild requirements:

- Fix provider identity first.
- Return typed control outcomes.
- Handle expired auth, disconnected, Premium-required, no active device, 403, 429, offline, and stale conditions.
- Device picker.
- Confirmed playback action feedback.
- Desktop: persistent now-playing/transport/provenance rail plus collection/library/queue workspace.
- Mobile: linear content with sticky real transport actions.
- Use an actual analyser only when truthful data exists.
- Otherwise label atmospheric animation honestly.
- Stop animation/audio/timers when paused, hidden, unmounted, or reduced-motion.
- Recommendations must use visible inputs and expose provenance.
- Replace mouse-only records/spines/cards with semantic buttons/links.
- Use shared accessible Modal/Drawer primitives.
- Preserve explicitly labeled curated/sample content where useful.

## VECTOR Arcade context and requirements

VECTOR is `/vector` inside AXIS. It is not a separate neon arcade brand.

Selected console direction: Instrument Deck.

Required shell:

- Featured viewport.
- Compact library rail.
- Operational metadata.
- Brass/bone instrumentation.
- Play, Resume, Restart, Install Offline.
- Continue rail for recent games, saves, and conflicts.
- Utility strip for volume, controls, reduced motion, offline storage, sync health, and fullscreen.
- Mobile linear flow with sticky real actions.
- Titles and small copy remain DOM text.

Preserve platform infrastructure:

- Serializable typed registry and dynamic loaders.
- Fixed-step scheduler.
- Serialized lifecycle/finalization.
- Runtime error and context-loss handling.
- Owner-partitioned IndexedDB persistence.
- Local CAS and conflict preservation.
- Migration quarantine.
- Bounded save/event contracts.
- Owner-read/service-write RLS.
- Per-game offline manifests and route isolation.
- Pure deterministic mechanics and solver/reachability/completability tests.

Required platform hardening:

- Abortable shared Phaser bootstrap.
- Restore global patches in `finally`.
- Boot timeout/cancel and partial-game disposal.
- Offline save/conflict failures visible.
- BFCache and visibility resume.
- Truthful maturity/evidence fields.
- Correct capability, achievement, resume, offline, and availability claims.
- Route-level offline install actions.
- Distributed mutation rate limits.
- Mobile sticky-action design.
- Preserve bundle budgets.

Catalog truth at the audit snapshot:

1. Second Sense
   - Available.
   - Deterministic mechanics/save/score exist.
   - Visual CSS/presentation was stripped.
   - Cover embeds forbidden title/tagline copy.
   - Online and offline presentation must be rebuilt.
   - Preserve mechanics.

2. Brickrise
   - Planned.
   - Physics, reachability, progress, input, lifecycle, and shell exist.
   - Rendering is placeholder geometry.
   - Preserve core; rebuild art, animation, game feel, sound, and presentation.

3. Time to Fly
   - Planned.
   - Deterministic solver and five-level core exist.
   - Placeholder visuals.
   - Synchronous generation hitch.
   - False achievement claim.
   - Preserve physics/solver; move expensive generation off main thread and rebuild presentation.

4. Paper Glider
   - Planned.
   - Deterministic simulation, passability, resource cleanup, and shell exist.
   - Placeholder visuals.
   - No mid-flight resume.
   - Preserve core; rebuild presentation and make resume truthful.

5. Envoy Arena
   - Metadata only.
   - Depends on a stable shared Envoy identity contract.
   - Do not begin until at least eight validated identities exist.

6. Phantasy Axis
   - Metadata only.
   - Build fresh as one complete vertical slice.

7. Biome Lab
   - Metadata only.
   - Build fresh as one complete vertical slice.

8. MiniTown
   - Metadata only.
   - Build fresh as one complete vertical slice.

9. Neon Rift
   - Metadata only.
   - Build last because of its rendering/input/performance risk.

All four existing implementations were Claude-coauthored. Redo their presentation and game-feel layers. Do not discard deterministic cores unless an adversarial mechanics review proves they are unsalvageable.

Concept/art lanes may run in parallel, but game promotion must be serial. Keep only one newly promoted title under release review at a time.

## Envoy context and requirements

The earlier Envoy program was formally dropped and its code/art/worker removed. Current docs say not to reattempt it.

This prompt is an explicit owner decision reversing that drop.

First land an ADR that:

- Supersedes the prior drop.
- Authorizes a fresh Envoy design.
- Explicitly rejects resurrection of the removed Meridian/Cairn/Vesper/Solace visual system.
- Preserves the financial/action authority boundaries.
- Records that Envoy appearance is independent of capability.

Current reusable substrate:

- `agent_tasks`.
- Task activity.
- Routine runs and steps.
- Approvals.
- Exact 12-status vocabulary.
- Owner RLS.
- Server-controlled transitions.
- Focus, Intel, and Ask service behavior.
- Task deep-link support.
- AppShell presence suppression.
- Versioned Interface Studio preferences.

Build order:

### E0 — Governance and truth

- Refresh canonical state.
- Land the owner-reversal ADR.
- Create a new acceptance matrix and original concept evidence.

### E1 — Status and deep links

Build strict `EnvoyWorkViewV1` over durable records.

Required fields:

- Objective.
- Exact status label.
- Active step.
- Completed/total only when authoritative.
- Elapsed time when meaningful.
- Waiting reason.
- Other active-task count.
- Sync state.
- Task/run/approval/result targets.
- Review Approval action.

Never invent percentage completion.

Add exact selection for:

- Task.
- Routine run.
- Approval.
- Result.

### E2 — Static Envoy product

Create original:

- Atlas.
- Morrow.
- Aster.
- Soma.

Required states:

- Idle.
- Running right.
- Running left.
- Waving.
- Jumping.
- Failed.
- Waiting.
- Running.
- Review.

They should be sophisticated, anthropomorphic, readable at small sizes, non-robotic, and distinct from monolith/deck/orb forms.

Add:

- Deterministic artifact validator.
- Strict preference migration.
- Interface Studio quick picker.
- Show/hide.
- Animation intensity.
- Compact preview.
- Sync state.
- Envoy Lab link.
- Full Envoy Lab preview, rename, archive/delete, export, storage, history, privacy, and cost surfaces.

### E3 — Feature-flagged Envoy host

- Status-first click.
- Focus/Intel/Ask as secondary capability modes.
- Realtime plus bounded polling.
- Multiple active tasks.
- Exact deep links.
- Pause on hidden/game routes.
- Reduced motion.
- Legacy Mascot retained as rollback until parity.

### E4 — Generation control plane

Add:

- Owner-scoped Envoys.
- Jobs.
- Job events.
- Assets.
- Usage/cost records.
- Private dedicated Storage bucket.
- Create/read/cancel/retry APIs.
- Quotas and idempotency.
- Service-only atomic claim, lease, heartbeat, stage, artifact, and terminal RPCs.
- Fixed `search_path`.
- Revoked browser worker-state writes.
- RLS, cross-user, private Storage, and signed-URL tests.
- Vercel worker-health capability check.

Do not add a cosmetic Generate button before this exists.

### E5 — Deterministic worker

- Pinned Hatch tooling, version, license, and SHA.
- Node 24 plus required Python/image tooling.
- Worker-owned temporary directories.
- Path containment.
- Fixed spawn arguments.
- Renewable database-time leases and fencing.
- Cancellation.
- Transient-only retry.
- Persist stage before work.
- Deterministic atlas validation.
- Private uploads.
- Cleanup.
- Production-impossible fixture provider for CI.

### E6 — Paid hosted proof

Immediately before implementation, consult official current OpenAI image documentation.

Then verify:

- Worker-only OpenAI key.
- Explicit timeout/abort.
- No automatic opaque retries.
- Persisted request, usage, and cost metadata.
- Render deployment and heartbeat.
- Lease reclaim/crash recovery.
- Real OpenAI-backed job.
- Separate cancel test.
- Separate retry test.
- Browser close/reopen.
- Cross-device selection sync.
- Private signed rendering.
- Final `pet.json` and atlas in AXIS.
- Exact-SHA Vercel validation.
- Sentry review with no PII.

Only after static and generated identities are stable should Envoy Arena begin.

## Module maturity baseline

Treat grades as code maturity, not hosted certification:

- Tasks / Approvals / Memory: A-
- Mail: B+
- Debrief: B+
- Dispatch: B
- People: B
- Literature: B
- Pipeline: B
- Control Room: B
- Agenda: B-
- Schedule: B-
- Notes: B-
- Objectives: B-
- Briefing: C+
- Library: C+
- Command: C+
- Fund: C+ and financially blocked
- Vitality: C / lab
- Atelier: C / lab
- Listening Vault: C / lab
- Supper Club: C / lab
- VECTOR platform: A-
- VECTOR catalog: C
- Envoys: unbuilt
- Desktop / Archive Bay: A- runtime, C release

Reassess each grade from current code before modifying it.

## Multi-agent operating model

Use the available concurrency as a four-seat cell:

1. Primary orchestrator/state steward.
2. Adversarial/security/data reviewer.
3. Implementer.
4. UX/accessibility/performance reviewer.

Rotate roles between waves. The module implementer may not be the final independent reviewer.

Subagents share the filesystem. Coordinate edits to avoid overlapping files and immediately communicate shared-contract changes.

For every module or coherent vertical slice, repeat:

1. Inspect current workflow and data/provider paths.
2. State current and expected behavior.
3. Map authentication, ownership, schema, RLS, provider, Sentry, and rollback impact.
4. Write failing tests for the defect and error paths.
5. Create a concrete interaction/design contract.
6. Implement the complete vertical slice.
7. Run fault injection.
8. Run independent adversarial review.
9. Repair.
10. Repeat review until no P0/P1 remains.
11. Run local gates.
12. Run preview, migration, provider, and Sentry gates.
13. Merge and verify production.
14. Re-derive canonical state and write the handoff.

Dynamic rules:

- If a module exposes a shared root cause, move the correction into the shared-foundation phase and invalidate dependent approvals.
- Security, financial truth, cross-account access, or unknown mutation outcome stops the affected release.
- Schema changes trigger full migration replay and hosted RLS testing.
- Visual changes trigger mobile, theme, keyboard, reduced-motion, and screenshot review.
- Provider behavior that cannot be verified remains explicitly unsupported.
- P2 acceptance requires owner, rationale, and expiration.
- P0/P1 cannot be waived.
- Do not create nine game shells or cosmetic Envoy generation UI.

## Execution phases

### Phase 0 — Release and truth containment

Run first.

Parallel work:

- Protect `main` and install required checks.
- Fix current red authenticated CI and public concurrency/readiness.
- Fix exact-head state currency.
- Re-derive canonical state.
- Reconcile stale handoff/VECTOR docs.
- Land the Envoy owner-reversal ADR.
- Upgrade vulnerable dependencies.
- Add blocking audit/SBOM.
- Replace the historical release validator with a current release/migration manifest.

Suggested branch:

`codex/redesign-00-release-containment`

Exit criteria:

- Protected main.
- No direct pushes.
- Required CI fully green.
- No high/critical production dependency findings.
- Exact SHA and migration count.
- Production cannot begin from unchecked code.

### Phase 1 — Trust and safety kernel

Parallel lanes:

- User-bound provider identity and safe OAuth lifecycle.
- Shared safe outbound fetch boundary.
- Financial provenance and notification recovery.
- Cancellable/idempotent provider mutations.
- Fail-closed auth and distributed rate limits.
- Safe error normalization.

Suggested coordinated branches:

- `codex/redesign-01-identity-integrations`
- `codex/redesign-01-safe-fetch`
- `codex/redesign-01-financial-truth`
- `codex/redesign-01-mutation-kernel`

Merge only when the containment release is green as a whole.

### Phase 2 — Shared product primitives

Build:

- Typed mutation state.
- DataBoundary.
- Provenance/freshness/sync rail.
- Accessible action/confirm/undo/dialog primitives.
- Strict provider adapters.
- Versioned local-first sync and conflict resolution.
- Realtime state with polling recovery.
- Coordinate-based board layout.
- Visibility-aware scheduler/RAF/audio hooks.

### Phase 3 — Data truth and integration integrity

- Remove fake Notes/Vitality seeding.
- Clean known fabricated data safely.
- Dispatch idempotency.
- Schedule overlap and recurrence.
- Library deletion integrity.
- Atelier private assets and dedupe.
- Settings synchronization.
- Durable cron/webhook execution.

### Phase 4 — Command and Listening Room

Run in parallel after dependencies are stable.

Complete each through design, implementation, independent review, repair, responsive/a11y/performance validation, preview, and production verification.

### Phase 5 — Module sweep

Parallel lanes:

- Work: Mail, Dispatch, Agenda, Schedule, Tasks, Approvals, Debrief.
- Knowledge: Notes, People, Briefing, Literature, Pipeline, Objectives, Library.
- Personal/operations: Fund, Vitality, Atelier, Supper Club, Control Room.

Every workflow must satisfy:

`list → detail → action → persistence → feedback → error → reload`

### Phase 6 — VECTOR and Envoys

Parallelizable preparation:

- VECTOR platform hardening.
- Game concept/art work.
- Envoy governance/status/static design.

Serial release:

- Second Sense complete presentation.
- Brickrise.
- Time to Fly.
- Paper Glider.
- Envoy status/static product.
- Envoy generation control plane and worker.
- Envoy Arena only after identity readiness.
- Remaining titles one at a time.

### Phase 7 — Cross-module journeys

Required authenticated journeys:

- Mail → Dispatch → Task/Note/Person → Agenda → Debrief.
- Briefing/Literature → Notes → Pipeline/Objectives.
- Schedule recurrence → Agenda/Command.
- Spotify expiry/reconnect/device/Premium/rate-limit.
- Supper Club → Vitality using real data.
- Fund intent → approval → provider receipt → immutable execution.
- VECTOR offline → reconnect → conflict → recovery.
- Envoy task → wait/approval → exact link → result.

Inject second-step failure and retry into every cross-module journey.

### Phase 8 — Cohesive UX, accessibility, and performance

Review every route across:

- Dark, dim, light, slate.
- Density, typography, radius, accent.
- 320px, tablet, desktop.
- Keyboard and screen reader.
- Touch.
- Reduced motion/transparency.
- Empty, stale, disconnected, error, denied, offline.
- LCP, INP, CLS, long tasks.
- Hidden timers and RAF.
- Bundle budgets.

Remove dead chrome, hover-only controls, fake operational claims, and developer-facing setup copy.

### Phase 9 — Hosted rollout

For every phase:

1. Local gates.
2. PR.
3. Exact-SHA Vercel preview.
4. Apply/read back migrations.
5. Owner/other-user/anonymous RLS test.
6. Private Storage test.
7. Provider sandbox/live smoke.
8. Preview-window Sentry review.
9. Manual acceptance.
10. Protected merge.
11. Production health/Sentry check.
12. State derivation and handoff.

## Required gates

Local:

- `npm run state:check`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`
- `npm run build`
- Bundle and route budgets
- Public E2E
- Authenticated E2E
- Dependency audit
- Focused security/fault-injection tests
- Accessibility checks
- Visual screenshots
- Desktop checks where relevant

Database:

- Migration replay from clean local database.
- Version/order validation.
- Linked-environment application/readback.
- Owner, other-user, and anonymous RLS matrix.
- Service-role-only mutation verification.
- Storage privacy and signed-URL verification.
- Rollback/repair plan.

Hosted:

- Exact-SHA preview.
- Happy and failure paths.
- Provider transport matrix.
- No false success.
- Sentry exact release/environment window.
- No new/regressed issues.
- Production canary.
- Rollback verification.

Credentials or tooling unavailable:

- Do not claim readiness.
- Identify the exact missing capability.
- Record the exact command/query/test.
- Name the required human owner.
- State whether the blocker affects preview, migration, provider validation, Sentry, Render, OpenAI, signing, or production.

## Definition of done

A module or phase is done only when:

- Complete vertical workflows function.
- No fake live data or progress exists.
- Every async action has honest pending/success/error/unknown state.
- Persistence survives reload.
- Cross-device semantics are explicit.
- Provider provenance and freshness are visible.
- Authentication and ownership are enforced locally and with RLS.
- Destructive actions have confirmation or undo.
- Error paths are visible and observable.
- No secrets or private content enter logs/Sentry.
- Keyboard, touch, mobile, reduced-motion, and reduced-transparency behavior pass.
- Local checks are green.
- Hosted gates are green.
- No open P0/P1 exists.
- Accepted P2 risks have an owner and expiration.
- Canonical program state is re-derived from git.

## Begin now

Start Phase 0 immediately.

Do not respond with only another plan. Use subagents to verify the audit baseline in parallel, create the phase plan, establish the dedicated branch or branches, and implement the first containment wave.

Your first execution sequence should be:

1. Reconcile current local/GitHub/hosted state.
2. Establish or verify branch protection and required checks.
3. Fix the state-currency false-green.
4. Fix current CI failures.
5. Remediate runtime dependency advisories.
6. Land the Envoy reversal ADR and truthful program state.
7. Run all Phase 0 local and hosted gates.
8. Commit, push, open PR, review, repair, merge, and verify production.
9. Re-derive state.
10. Continue directly into Phase 1 unless genuinely blocked.

Maintain concise commentary updates while working. Preserve a durable defect/evidence ledger and continuation handoff after every wave.

End every work session using the exact final-response block required by `AGENTS.md`.