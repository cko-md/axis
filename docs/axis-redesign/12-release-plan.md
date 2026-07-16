# 12 — Release, Rollback, and Recovery Plan

This is the release runbook for the 2026-07-16 task/approval, WebAuthn, and
routine-resume safety wave. It is deliberately expand → application → contract.
The historical migration set is not renamed or rewritten.

## Deployment owner

Vercel's Git integration is the sole production deployment owner. Merging an
approved PR to `main` creates the production deployment. AXIS does not also run
`vercel deploy --prod` from GitHub Actions because two deployment owners can
race, publish different revisions, and make rollback evidence ambiguous.

Manual production CLI deploys are incident-recovery actions only. The incident
commander must record the Git revision, Vercel deployment ID, reason, and
recovery owner.

## Release manifest

Expansion migrations, in order:

1. `supabase/migrations/202607161300_task_approval_atomic.sql`
2. `supabase/migrations/202607161302_webauthn_atomic.sql`
3. `supabase/migrations/202607161400_routine_resume_claims.sql`

Application:

4. Merge the verified application revision to `main`; wait for that exact Git
   revision to be Ready in the Vercel production project.

Contract:

5. `supabase/migrations/202607161401_task_approval_lockdown.sql`

**NEVER apply the contract migration before the compatible application revision
is confirmed live in production.** It removes browser DML policies/grants used
by the older application and replaces the legacy passkey `FOR ALL` policy with
owner SELECT only. A green preview is necessary but is not proof that the
production revision is live.

Run `npm run release:validate` before starting. It checks file ordering,
transaction wrappers, safety markers, read-back scripts, documentation, and
that no GitHub workflow owns a second Vercel production deployment. It also
prints SHA-256 checksums; paste that output into the release record.

## Preconditions

- CI, production build, authenticated/public browser gates, preview validation,
  post-preview Sentry review, and manual workflow checks are green.
- The Supabase target is confirmed as `twkcvyhmlguipchfetge`.
- A current database backup/PITR point and a named database recovery owner exist.
- `supabase migration list --linked` is captured before mutation.
- The operator has the Supabase CLI and authorized linked-project access.
  The commands below were validated against Supabase CLI 2.109.1.
- `SUPABASE_DB_URL` is loaded from the approved secret manager for the intended
  project and is never echoed, logged, or written to the repository.
- No one runs `supabase db push`; the repository's historical migration tracking
  differs from lexical filenames. Apply only the named files below.

## Stage 1 — expansion

Preflight:

```bash
npm run release:validate -- --stage=expand
supabase migration list --linked
```

For each file, execute the SQL, confirm success, then mark only that exact
version applied:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202607161300_task_approval_atomic.sql
supabase migration repair 202607161300 --status applied --linked

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202607161302_webauthn_atomic.sql
supabase migration repair 202607161302 --status applied --linked

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202607161400_routine_resume_claims.sql
supabase migration repair 202607161400 --status applied --linked
```

Then run:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/sql/verify-20260716-expand.sql
supabase migration list --linked
```

These files are multi-statement scripts. The prepared-query implementation
behind `supabase db query --file` is not a valid executor for this release wave.
Use the controlled `psql` path above or another explicitly validated
multi-statement-capable PostgreSQL executor.

The expansion verifier intentionally fails if the contract removed the legacy
owner-write policies too early. Local behavioral validators remain mandatory:

```bash
node scripts/validate-task-approval-cas.mjs --local
node scripts/validate-webauthn-atomic.mjs --local
node scripts/validate-routine-resume-claims.mjs --local
```

If SQL succeeds but `migration repair` fails, do not rerun the migration
blindly. Run the read-back query, inspect migration history, and repair only the
history entry after confirming the schema is present.

## Stage 2 — application

Merge the approved commit to `main`. Vercel Git integration performs one
production deployment. Record all of:

- Git SHA from `main`
- Vercel production deployment ID and Ready timestamp
- `/api` and authenticated workflow smoke evidence
- Sentry query window and result
- confirmation that task transitions, approval decisions/step-up, passkey
  management/login, and routine resume use the new RPC paths

If the deployment fails or the new RPC paths are not healthy, stop. The
expansion schema is backward-compatible, so keep the old application live and
fix forward. Do not apply the contract.

## Stage 3 — contract

The database recovery owner and release approver must explicitly authorize this
stage after the exact compatible Git SHA is live:

```bash
export PRODUCTION_SHA="replace-with-deployed-git-sha"
export RECOVERY_OWNER="replace-with-incident-owner"

npm run release:validate -- \
  --stage=contract \
  --expansions-verified \
  --app-live-revision="$PRODUCTION_SHA" \
  --contract-approved \
  --recovery-owner="$RECOVERY_OWNER"
```

Apply and verify:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/202607161401_task_approval_lockdown.sql
supabase migration repair 202607161401 --status applied --linked
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/sql/verify-20260716-contract.sql
supabase migration list --linked
```

Repeat the authenticated write-path smoke and Sentry review immediately. The
contract verifier checks policy/grant catalogs and executes authenticated
passkey insert/update/delete probes that must fail at the table-privilege
boundary. The contract migration is transaction-wrapped; a SQL error rolls the
migration back. A successful contract plus a failed read-back is an incident
and blocks release completion.

## Rollback and recovery

- **Before contract:** roll the application back through Vercel to the last
  healthy revision. Leave additive expansion DDL in place and fix forward.
- **During contract failure:** verify PostgreSQL rolled the transaction back,
  rerun the expansion read-back, and keep the compatible app deployed.
- **After contract:** do not promote an application older than the RPC cutover;
  its browser writes will fail by design. Prefer rolling forward to the last
  healthy compatible revision.
- **Emergency legacy recovery:** create and review a new timestamped recovery
  migration that restores only the required policies/grants, then apply it with
  the same database-owner controls. Do not edit, delete, mark reverted, or
  replay historical applied migrations.
- **Data issue:** halt writes where practical, preserve logs and migration
  history, use the named recovery owner/PITR process, and avoid ad hoc
  destructive SQL.

The release is complete only after the contract read-back, production workflow
smoke, Sentry review, migration-history capture, and rollback evidence are
attached to the PR/release record.

## PR #195 pre-production evidence

The redesign branch has green local production gates at revision
`89705a4a`: 1072 Vitest tests across 166 files, clean typecheck/lint,
`release:validate`, a 163-page production build with all 182 route budgets and
4017/4400 KB aggregate static JS, public Playwright 13/13, and authenticated
Playwright 14/14 including auth setup. Hosted expansion migrations are applied
and read back; the contract migration remains intentionally pending.

Production merge remains blocked until the exact final PR head has green CI and
an isolated Vercel preview workflow, a Sentry operator records the release- and
environment-scoped Issues result, required provider/manual security checks are
signed off, merge authorization is explicit, and the post-live contract stage
has a named recovery owner.
