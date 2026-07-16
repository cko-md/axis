# Wave 15.1 — Main integration and lifecycle safety

- Date: 2026-07-16
- Branch: `codex/vector-arcade-envoys`
- Status: landed — local gates green; sealed as a two-parent merge
- Merge parents: `960d20f4` (Wave 15.0) and
  `a029cd58392a75497113685b9363c4f3e617f672` (`origin/main`)
- Rescue provenance:
  `c2de93082a38ad3de08b3a84c6d55ed84b357e07`, applied patch-equivalent only
  without its unrelated stacked ancestry
- Implementation spec: `.prompts/envoys/VE-WAVE-15.1-INTEGRATION.md`

## Invariant and integration decision

Current-main fixes and Phase 9 redesign foundations both survive. Preference,
task, approval, and routine races fail safely and visibly; browser sessions
cannot mint execution authority or forge durable routine audit records.

Choosing `main` alone would have omitted the open redesign foundations. Choosing
the Phase 9 child as the branch base would have created a stacked dependency.
This wave instead preserves the Phase 9 branch, merges current `origin/main`,
applies only the canonical `c2de9308` repair, and records one two-parent merge.

## Delivered

- current-main date/timezone, Debrief, accessibility, Agenda, Atelier, featured
  photo, Library, and Pipeline fixes retained;
- Phase 9 routine/approval foundations retained;
- versioned, validated Interface Studio preference envelope with:
  - unknown outer and nested field preservation;
  - valid stored IANA timezone preservation and invalid timezone repair;
  - future-version read-only refusal;
  - no authenticated write after a failed remote read;
  - no hydration echo-save;
  - owner/cache/auth-generation isolation;
  - per-field pending edit merge;
  - serialized fresh-read `updated_at` compare-and-set writes;
  - visible loading/sync/error/retry/incompatible states;
- atomic owner-scoped `transition_agent_task` status + activity RPC;
- atomic service-only `create_agent_task` task + activity RPC that verifies
  routine provenance and requires a live matching claim for claimed work;
- approval creation/decision/step-up writes moved behind authenticated
  service-role routes with expected-status compare-and-set;
- passkey credential rows and pending ceremonies made server-only, with all
  browser policies/grants removed and legacy stored refresh tokens purged;
- exact `ceremonyId` binding, one-time delete-returning challenge consumption,
  and expected-counter compare-and-set before authentication or approval
  authority is stamped;
- per-IP pre-auth authentication and per-user registration/approval option plus
  verification throttles, with Redis and in-memory fallback;
- passkey login replaced stored-session/token exchange with a server-only,
  one-time Supabase link mint consumed through SSR cookies; no token, hash,
  refresh token, or link is returned, persisted, or logged;
- exact approval-to-routine-run scope binding;
- caller-token atomic routine claim/renew/finalize/release/repause RPCs;
- claim-fenced routine-step start/complete/fail and task creation;
- renewable ten-minute leases plus stale-worker quarantine: recovery invalidates
  the old token, prevents late writes, and requires operator review before a
  quarantined run can execute again;
- generic blocked-run retry rejects quarantined or authority-bearing runs;
- durable recovery for lost claim, repause, step-completion, and terminal-run
  responses;
- browser DML revoked for approvals and trusted routine run/step audit rows;
- fail-closed local Supabase bootstrap guidance and migration repair that drops
  unexpected passkey/challenge policies instead of relying on policy names;
- Playwright project routing repaired so Operate flows run only in the
  authenticated project and selectors target the intended controls;
- real Chromium virtual-CTAP2 resident-key coverage for registration, actual
  sign-out, fresh passkey session restoration, authenticated API access, and
  cleanup on the exact `localhost` RP origin.

Not delivered or claimed:

- any VECTOR route, game, save/sync/offline worker, Envoy runtime, Envoy Lab,
  generation worker, Render/OpenAI integration, hosted migration, Vercel
  preview, Sentry review, or production completion.

## Complete changed-file inventory

Program/evidence:

- `.claude/axis-redesign/PROGRAM_STATE.json`
- `.claude/axis-redesign/DEFECT_LEDGER.json`
- `.logs/vector-envoys/INDEX.md`
- `.logs/vector-envoys/wave-15.1-integration-safety.md`
- `.prompts/envoys/VE-WAVE-15.1-INTEGRATION.md`
- `AGENTS.md`
- `docs/DESIGN_HANDOFF.md`
- `docs/axis-redesign/07-security-model.md`
- `docs/axis-redesign/13-final-verification.md`
- `docs/axis-redesign/15-completion-matrix.md`
- `docs/axis-redesign/adr/0002-action-taxonomy-approval-kernel.md`
- `docs/axis-redesign/security/step-up-review.md`
- `docs/env.md`
- `docs/production-readiness.md`
- `playwright.config.ts`
- `src/lib/redesign/artifacts.test.ts`
- `tests/e2e/adversarial-rescue.spec.ts`
- `tests/e2e/operate.spec.ts`
- `tests/e2e/passkey-authenticated.spec.ts`

Current-main preservation:

- `src/app/globals.css`
- `src/components/agenda/AgendaModule.tsx`
- `src/components/atelier/AtelierModule.tsx`
- `src/components/console/FeaturedPhotos.tsx`
- `src/components/debrief/DebriefModule.tsx`
- `src/components/library/LibraryModule.tsx`
- `src/components/pipeline/PipelineModule.tsx`
- `src/lib/a11y.ts`
- `src/lib/calendar/event-dates.ts`
- `src/lib/calendar/event-dates.test.ts`
- `src/lib/dates.ts`
- `src/lib/dates.test.ts`

Preferences:

- `src/components/theme/ThemeProvider.tsx`
- `src/components/theme/InterfaceStudioDrawer.tsx`
- `src/lib/theme/interface-preferences.ts`
- `src/lib/theme/interface-preferences.test.ts`

Task/approval/routine lifecycle:

- `src/app/api/agent-tasks/route.ts`
- `src/app/api/agent-tasks/route.test.ts`
- `src/app/api/agent-tasks/[id]/route.ts`
- `src/app/api/agent-tasks/[id]/route.test.ts`
- `src/app/api/approvals/route.ts`
- `src/app/api/approvals/route.test.ts`
- `src/app/api/approvals/[id]/route.ts`
- `src/app/api/approvals/[id]/route.test.ts`
- `src/app/api/approvals/[id]/step-up/route.ts`
- `src/app/api/approvals/[id]/step-up/route.test.ts`
- `src/app/api/routines/concentration-check/route.ts`
- `src/app/api/routines/concentration-check/route.test.ts`
- `src/app/api/routines/rebalance-proposal/route.ts`
- `src/app/api/routines/runs/[id]/resume/route.ts`
- `src/app/api/routines/runs/[id]/resume/route.test.ts`
- `src/components/approvals/ApprovalsModule.tsx`
- `src/lib/hooks/useApprovals.ts`
- `src/lib/hooks/useApprovals.test.ts`
- `src/lib/routines/concentrationCheck.ts`
- `src/lib/routines/concentrationCheck.test.ts`
- `src/lib/routines/executor.ts`
- `src/lib/routines/executor.test.ts`
- `src/lib/routines/runState.ts`
- `src/lib/security/approvalCardView.ts`
- `src/lib/security/approvalCardView.test.ts`
- `src/lib/supabase/admin.ts`
- `src/lib/supabase/database.types.ts`
- `src/lib/tasks/taskPersistence.ts`
- `supabase/migrations/202607161000_lifecycle_claims.sql`

Passkey/session authority:

- `src/app/api/auth/passkey/authenticate/route.ts`
- `src/app/api/auth/passkey/delete/route.ts`
- `src/app/api/auth/passkey/list/route.ts`
- `src/app/api/auth/passkey/register/route.ts`
- `src/app/api/auth/passkey/token/route.ts` (deleted)
- `src/app/api/auth/passkey/passkey-authority.test.ts`
- `src/app/login/page.tsx`
- `src/components/auth/BiometricGate.tsx`
- `src/hooks/usePasskey.ts`
- `src/lib/env.ts`
- `src/middleware.ts`

Typed-admin compatibility fixes:

- `src/app/api/cron/daily/route.ts`
- `src/app/api/cron/feed-digest/route.ts`
- `src/app/api/webhooks/make/route.ts`

## Defect-ledger delta

Closed:

- `PREF-001` — failed preference read could overwrite remote state and erase
  timezone/unknown fields;
- `RUN-002` — approval could be consumed before resumed work succeeded;
- `TASK-002` — stale task/approval decisions could overwrite concurrent winners;
- `SEC-004` — browser-forgeable approval/routine authority and audit rows;
- `SEC-005` — replayable challenge/stale passkey-counter race;
- `RUN-003` — crashed resume claims could wedge permanently;
- `RUN-004` — lost repause response could create a false failed step;
- `RUN-005` — lost completion responses could replay completed work or misreport
  terminal state;
- `PREF-002` — ownerless preference-cache adoption could leak state across
  account changes;
- `TASK-003` — caller-supplied routine provenance and non-atomic task/activity
  creation could forge durable audit relationships;
- `SEC-006` — passkeys retained encrypted refresh-token authority and exposed a
  browser token-exchange route;
- `SEC-007` — ceremonies were not exactly identified/consumed and option
  endpoints could be abused without the intended throttling;
- `SEC-008` — browser policies/grants allowed credential/challenge authority to
  drift back to the client;
- `RUN-006` — an expired worker could continue writing after stale recovery;
- `RUN-007` — the generic blocked-run retry path could bypass stale-claim
  quarantine without a claim token;
- `SEC-009` — local bootstrap restored broad grants/policies and could silently
  recreate browser authority;
- `SEC-010` — the migration could partially autocommit before its duplicate-link
  preflight failed.

`STATUS-001` remains open for the broader Wave 15.4 active-work projection:
Wave 15.1 now surfaces task-activity failures, but routine-step and linked
approval degradation still need the shared truthful HUD contract.

## Migration, grants, RLS, and data safety

Migration: `supabase/migrations/202607161000_lifecycle_claims.sql`.

It:

- wraps the complete security/data/ACL change set in one transaction, including
  the duplicate-link preflight;
- creates `create_agent_task` as a service-only atomic task/activity boundary
  with owner, routine-key, claim-token, lease, and quarantine checks;
- adds approval `executing` state and claim/audit fields;
- adds routine resume claim token, claimed-at, expiry, and attempt fields;
- adds exact `(execution_run_id,user_id)` ownership FK;
- preflights duplicate `routine_runs.approval_id` links before the unique index;
- revokes browser task-lifecycle, approval, routine-run, and routine-step
  mutation authority while preserving owner-scoped reads;
- grants `transition_agent_task` only to `authenticated`;
- removes every browser policy/grant from `user_passkeys` and
  `webauthn_challenges`, revokes challenge cleanup from browser roles, and
  purges legacy `refresh_token_enc` values;
- grants task creation plus routine claim/renew/step/finalize/release/repause/
  stale-recovery RPCs only to `service_role`;
- guards stale-quarantined `blocked → running` transitions at the database
  boundary and rejects unclaimed task provenance with retained authority
  metadata;
- uses fixed/empty search paths and fully qualified relations;
- keeps all user ownership predicates explicit.

Production preflight before apply:

```sql
select approval_id, count(*)
from public.routine_runs
where approval_id is not null
group by approval_id
having count(*) > 1;
```

Local readback:

```text
duplicate approval links: 0
authenticated transition_agent_task execute: true
authenticated create_agent_task execute: false
service_role create_agent_task execute: true
authenticated claim_routine_approval_resume execute: false
service_role claim_routine_approval_resume execute: true
authenticated renew/start/complete/fail claim RPC execute: false
service_role renew/start/complete/fail claim RPC execute: true
authenticated approval insert/update: false/false
authenticated routine_runs insert/update: false/false
authenticated routine_step_runs insert/update: false/false
authenticated passkey/challenge grants: none
passkey/challenge browser policies: 0/0
approvals_status_check: present
approvals_execution_run_owner_fkey: present
```

The transactional SQL suite covers legal/stale/illegal task transitions,
terminal timestamps, atomic activity, browser privilege denial, claim
winner/loser, wrong-token release, release restore, finalize atomicity,
cross-owner denial, exact scope mismatch, expiry, stale step-up, repause, stale
claim recovery, fresh-claim retention, and claimed-run mutation denial.
It also covers lease renewal, old-token step/task rejection, stale-worker
quarantine, database-level quarantine transition refusal, generic retry
exclusion, unclaimed provenance metadata guards, exact RPC ACLs, passkey/
challenge zero-policy authority, legacy-token purge, first-apply repair, and
idempotent migration replay. A forced duplicate-link failure proved transaction
rollback by preserving deliberately altered pre-migration ACLs and fixture data;
cleanup, successful apply, replay, and the full authority suite then passed.

Tembo remains unused; no role is inferred.

## Validation

Passed locally:

```text
focused lifecycle/passkey Vitest: pass
full Vitest: 919/919 across 134 files
TypeScript: clean
ESLint: 0 errors, 0 warnings
local lifecycle SQL transaction suite: pass
local migration first-apply + idempotent replay: pass
forced duplicate-link preflight rollback: pass
public Playwright against production build: 13/13
authenticated Playwright against local production build: 7/7
dedicated real WebAuthn Playwright: 1/1
Next production build: 159 static pages
bundle budget: 3927/4400 KB (89.3%)
per-route budgets: 175/175
git diff --check: pass
JSON parse: pass
```

Authenticated browser QA used a temporary local-only Supabase user, exercised
Mail, Agenda/Schedule/Notes/Command, legacy redirects, financial profile and
memory persistence, Tasks, Approvals, Operate routing, and a real virtual
resident passkey, then deleted the user and auth state. The passkey flow used
the exact `http://localhost:3010` RP origin and captured/visually inspected:

- `/private/tmp/axis-wave151-passkey-qa/passkey-registered.png`
- `/private/tmp/axis-wave151-passkey-qa/passkey-signed-out.png`
- `/private/tmp/axis-wave151-passkey-qa/passkey-restored-session.png`

The runner sourced deterministic credentials only from the local Docker stack,
cleared every hosted provider/Sentry/OpenAI key, and verified the client bundle
contained the local Supabase URL and no hosted project URL. No hosted app data
was read or mutated by browser QA.

## Review

Independent lifecycle and adversarial reviews found browser-forgeable authority,
wedged claims, response-loss replay, passkey ceremony/counter races, stale-worker
overlap, and a generic-retry quarantine bypass. Every P0/P1 finding was repaired
and regression-tested. The final independent rerun found no remaining P0/P1 in
the reviewed lifecycle/authority scope.

Residual reviewed risks:

- physical authenticator testing and independent human security sign-off remain
  required before any real side-effecting financial execution is enabled;
- ordinary non-authority blocked runs may still use status CAS, but any run with
  approval, pause, claim, or stale-quarantine metadata is refused by that path;
- hosted schema/data/grant state is unverified for this migration.

## External production gates

Only GitHub is operational for this session. `gh auth status` emits a stale
warning, but direct authenticated API checks identify `cko-md` and confirm
admin/push permission on `cko-md/axis`.

Every other hosted gate remains explicitly blocked:

| Gate | Status | Exact blocker | Required owner/authorized action |
|---|---|---|---|
| Production Supabase migration/readback | blocked | Hosted service-role REST responds, but there is no management/DB/DDL credential, linked CLI, or MCP. Data-plane access is not migration authority. | Authorize the production target; run the duplicate-link preflight, apply `202607161000_lifecycle_claims.sql`, then read back migration history, constraints, RLS, grants, RPC ACLs, and advisors. |
| Vercel preview validation | blocked | GitHub deployment metadata is visible, but no local Vercel CLI/token/session/project link exists and the preview is protected by Vercel SSO. | Provide an authorized Vercel team session or preview-bypass credential; validate build, happy/error/concurrency paths, logs, and env parity on the branch preview. |
| Sentry regression review | blocked | The local token has only `org:ci`; project/issue queries return 403. | Provide a separate least-privilege project/event read token and query the exact preview release/environment window. |
| Render worker deployment | blocked | No Render API credential, service, or blueprint exists yet. | Provision the worker service identity after its implementation lands; inject worker-only secrets in Render. |
| OpenAI paid generation smoke | blocked | No OpenAI project key is configured and the generation worker is not yet implemented. | Provision a project-scoped worker-only key with budget controls, then run the required paid job and cancellation smoke. |

These blockers are not waived or converted into passes by local validation,
read-only hosted data-plane access, GitHub deployment metadata, or Sentry
source-map upload scope. Production promotion remains blocked until the
applicable hosted gates pass.

No production migration, deploy, paid provider job, or application-data
mutation was performed; hosted activity was limited to safe identity,
permission, deployment-metadata, and capability probes.
