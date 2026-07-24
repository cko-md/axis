# AXIS adversarial remediation checkpoint — 2026-07-23

## Resume contract

This is the durable continuation record for the owner-authorized AXIS System
Redesign adversarial remediation program. Read it together with the
[original program prompt](../axis-redesign/16-adversarial-remediation-production-convergence-program.md),
which is committed byte-for-byte from the owner attachment (SHA-256
`58f67f5959e5f58dd94628cf18d96498d437489ee52ac663e70578b8baf1f9b6`).

The session stopped at the owner's request. No redesign branch was merged, no
production deployment was initiated, and no hosted migration was applied by
this checkpoint operation. WIP branches are preservation points, not release
candidates.

## Frozen remote checkpoints

| Lane | Remote branch | Full checkpoint SHA | State |
|---|---|---|---|
| Phase 0 governance bootstrap | `codex/redesign-00-governance-bootstrap` | `d6be926101af138a8adde7d962066a21232d871f` | Implementation/evidence checkpoint complete and pushed; draft PR #267; not merged or production-certified. |
| Phase 1 auth and rate limits | `codex/redesign-01-auth-rate-limits` | `06e0ff014f5ee458b56f4c4fe788a45e5858cf8a` | Accepted lane checkpoint; independent review found no lane-local P0/P1; still requires composition and hosted gates. |
| Phase 1 financial truth | `codex/redesign-01-financial-truth` | `2c3da632c6bc0a9f061425c24e73428d2602953b` | WIP preservation checkpoint; critical review findings remain. Do not merge. |
| Phase 1 provider mutation kernel | `codex/redesign-01-mutation-kernel` | `36c0f8ab63068c2971306cfc98e491bf4f3b04d9` | WIP preservation checkpoint; critical review findings remain. Do not merge. |
| Phase 1 provider identity | `codex/redesign-01-provider-identity` | `d2e0ef20b854d5f15da12def5f6219197c5a68e0` | WIP preservation checkpoint; critical review findings remain. Do not merge. |

All five listed lane worktrees were clean immediately after their checkpoint
commit. The auth, financial, mutation, and identity branches were newly pushed
to `origin`. The governance checkpoint was already pushed.

## Work completed

### Phase 0 governance bootstrap

The branch contains the governance containment series from
`2a6f9c1` through `d6be926`, including release-control/bootstrap work,
exact-state derivation fixes, deterministic state evidence, current release and
migration validation, CI public-browser enforcement, the Envoy owner-reversal
ADR and acceptance material, dependency remediation, and refreshed derived
state. The latest branch commit binds the generated/current-state evidence to
the checkpoint.

This is a branch-level implementation checkpoint only. The original program's
Phase 0 exit criteria are not satisfied until the PR is independently reviewed,
all required exact-SHA local/hosted gates pass, protected merge completes, and
production/state verification is recorded.

### Phase 1 auth and distributed admission

The accepted lane implements fail-closed auth configuration and API policy,
distributed admission/rate limiting, bounded JSON parsing, MFA trust-device
revocation epochs, credential-column lockdown, safe provider error
normalization, advisor evidence restrictions, and focused fault-injection,
migration, and policy tests.

Captured evidence before freeze:

- Node 24 typecheck and lint passed.
- Release validation passed.
- Focused tests passed 330/330.
- Full unit run passed 2,220/2,224; the four failures were concurrency-timeout
  artifacts and their serial rerun passed 80/80.
- Production build passed.
- Public E2E passed 13/13.
- Both lane migrations were replayed twice and effective-role probes passed.
- Independent Sol review passed with no auth-lane P0/P1.

Known P2 follow-ups:

- Tighten middleware matcher boundaries for lookalike paths and dotted static
  assets.
- Apply hard body bounds to Massive and Advisor paths that only bound after
  headers.
- Tighten Supabase URL validation.
- Improve advisor failure observability.

Composition dependencies remain no-release until Plaid disconnect, legacy
authority recovery, canonical finance cron cash, link/status hardening, and
composed provider lifecycle tests are complete.

### Phase 1 financial truth

The WIP lane adds typed financial truth/provenance states, deterministic money
handling, provider-coverage modeling, balance-sheet synchronization, Plaid
link/exchange/status/disconnect/webhook hardening, notification outcome
propagation, Fund truth UI behavior, exact net-worth authority provenance, and
an extensive fault-test/DB-validation surface.

The DB validator exposed an authenticated-trigger privilege defect and the lane
was being repaired when stopped. The most recent captured DB run was 74/77
before additional fixes; final validation was not captured.

Outstanding P0/P1 work:

- Enforce hard request-body deadlines, not size-only bounds.
- Make single-Item/link-exchange attempts durable and database-enforced.
- Finish disconnect reconciliation and revoke-aware fact gating.
- Make coverage writes safe under equal-timestamp concurrency and persist
  global failure attempts.
- Retire or project the raw Plaid accounts/liabilities routes.
- Compose the separate order-intent/execution boundary; legacy order ticket and
  order routes remain unsafe.
- Repair direct transaction sync/RPC/cron defects that were deferred from this
  lane.
- Rerun all Node 24 gates, clean database replay/RLS verification, browser
  journeys, and independent Sol financial review.

### Phase 1 provider mutation kernel

The WIP lane adds a durable command/receipt ledger, stable calendar
idempotency, bounded and cycle-safe semantic HMAC canonicalization, provider
abort racing, failed-before-dispatch reopen semantics, tombstones,
service-controlled RLS, a partial disconnect contract, and a stale-command
reconciler.

Captured evidence before freeze included typecheck, lint, focused tests,
release validation, and diff checks. Expansion and contract migrations applied
on a disposable database. The expansion verifier was corrected after exposing
a stale DELETE premise, but a fresh final replay was not captured.

Outstanding P0/P1 work:

- Make hard cancellation actually terminate a hung provider operation.
- Eliminate stale-sweeper races and bound its work.
- Bind reconciliation proof to observed time/freshness, connection, owner, and
  provider.
- Compose opaque connection foreign keys/identity authority.
- Compose the Composio disconnect lifecycle with the identity lane.
- Keep Mail mutation paths no-release until stable provider response IDs and
  reconciliation proof exist.
- Rerun fresh expansion/contract verification and the full gate suite.

### Phase 1 provider identity

The WIP lane adds opaque local connection IDs, a private exact v3.1 provider
proof boundary, an authority table and lifecycle CAS, server-only boundaries,
read-only tool policy, client-safe projections, contract migration away from raw
connection tables, connection-ID-first Mail cache/sync behavior, bounded
admission/concurrency, and retirement of the generic mutation executor.

Focused tests (32 at the earlier checkpoint), typecheck, and lint had passed
before the final SQL/lifecycle edits. A full suite still had 26 legacy failures
that were not reconciled before stop.

Outstanding P0/P1 work:

- Persist connect attempts and compensate remote-orphan failures.
- Add distributed admission and hard deadlines across status/resolve/list.
- Ensure exact-proof failures transition to a non-authorizing lifecycle state.
- Expose truthful pagination/truncation state.
- Complete Contacts truth/pagination and Strava safe identity, defaults,
  status, and disconnect behavior.
- Resolve direct Strava callback dependency on the shared safe-fetch boundary.
- Compose disconnect with the mutation kernel.
- Finish and verify new-write opaque constraints, freshness-aware status,
  monotonic `DISCONNECTING → REVOKED`, RPC bounds, and supersession projection.
- Rerun clean DB verification, full tests/build/release gates, provider matrix,
  and independent Sol security review.

## Work not recovered into Git

Two delegated lanes produced useful work in temporary worktrees that no longer
exist. Durable replacement clones currently remain clean at the governance
baseline:

- `/Users/ogo.ko/.codex/worktrees/axis-redesign/phase1-safe-fetch`
  on `codex/redesign-01-safe-fetch`
- `/Users/ogo.ko/.codex/worktrees/axis-redesign/phase1-order-intents`
  on `codex/redesign-01-order-intents`

Do not treat those clean branches as completed lanes. Recover the code from the
Codex rollout evidence, re-review it, and only then commit it:

- Safe-fetch evidence:
  `/Users/ogo.ko/.codex/sessions/2026/07/23/rollout-2026-07-23T15-02-23-019f905b-8171-76e1-841a-978e8f44f5bd.jsonl`
- Order-intent implementation/review evidence:
  `/Users/ogo.ko/.codex/sessions/2026/07/23/rollout-2026-07-23T14-03-51-019f9025-e8a6-7a40-b3af-07f874a4b5e0.jsonl`
  and
  `/Users/ogo.ko/.codex/sessions/2026/07/23/rollout-2026-07-23T16-01-55-019f9092-00c3-7e32-9d6a-750992b5b7e9.jsonl`

The order-intent lane had implemented the separate intent/execution boundary,
immutable execution contract, routes/UI, migration/contract patches, DB
validation, and focused tests. Captured evidence reported focused 20/20 plus
typecheck, lint, state/release validation, and diff checks. None of that code is
present on the clean replacement branch yet.

## Integration hazards

The Phase 1 lanes deliberately overlap shared surfaces. Do not merge or
cherry-pick them wholesale into one another without contract reconciliation.
High-conflict areas include:

- `scripts/release-migration-manifest.json`
- `src/lib/supabase/database.types.ts`
- `src/lib/http/*`
- `src/lib/env.ts`
- `src/lib/integrations/composio.ts`
- Plaid/Fund routes and services
- Composio disconnect and lifecycle state
- Calendar/Mail mutation routes

Migration timestamps also overlap around `20260723210000`; resolve ordering and
manifest identity deliberately, then replay from a clean database.

## Exact next steps

1. Start in a new isolated worktree based on
   `d6be926101af138a8adde7d962066a21232d871f`; do not switch or alter the
   foreground checkout.
2. Reconcile current GitHub, Vercel, Supabase, Sentry, dependency, and protected
   `main` state before trusting this dated handoff.
3. Recover the safe-fetch lane first and obtain independent Sol security review.
4. Recover the order-intent lane and obtain independent Sol financial/database
   review.
5. Finish provider identity, then compose its opaque connection authority with
   the mutation kernel and disconnect lifecycle.
6. Finish the mutation kernel's hard cancellation and reconciliation proof.
7. Finish financial truth only after order-intent and provider lifecycle
   contracts are available.
8. Compose the accepted auth lane with the completed provider/finance
   contracts; resolve shared HTTP/admission code once.
9. Create a dedicated Phase 1 integration branch. Run clean migration replay,
   migration order/version checks, owner/other-user/anonymous RLS, service-role
   mutation probes, the full Node 24 gate suite, browser/provider fault
   injection, and independent final review until no P0/P1 remains.
10. Only then open/update PRs, run exact-SHA Vercel and Sentry/provider gates,
    merge through protected `main`, verify production, and re-derive canonical
    state.
11. Continue with Phases 2–9 exactly as defined in the committed original
    program prompt.

## Foreground checkout isolation

The foreground checkout `/Users/ogo.ko/Projects/axis` was not edited, staged,
committed, switched, stashed, reset, cleaned, or pushed by this checkpoint
operation. At the final read-only observation it was:

- Branch: `codex/spark-checkpoint-governance-bootstrap-20260723`
- HEAD: `cbd61bae18f0bd30bfe6c5b85ec7dcdc4c119fe0`
- Worktree: clean
- Tracking state: ahead 1, behind 1 relative to its configured remote branch

That checkout may be controlled by another active session. Re-read it before
any future action and do not infer permission to reconcile its divergence.

## Production/readiness status

Production readiness is blocked. There is no basis to claim Vercel preview,
production Supabase migration, provider-live, Sentry, Render/OpenAI, desktop
signing, or production canary completion for the WIP Phase 1 composition.
Hosted gates must be rerun against the exact eventual integration SHA.
