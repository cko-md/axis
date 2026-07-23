# 12 — Release, Rollback, and Recovery Plan

This is the release runbook for the 2026-07-16 task/approval, WebAuthn, and
routine-resume safety wave. It is deliberately expand → application → contract.
The historical migration set is not renamed or rewritten.

## Deployment owner

Vercel's Git integration is the sole production deployment owner. Merging a
source-changing PR to `main` creates a production attempt that the canonical
state gate intentionally skips. A following protected, generated-only state
refresh creates the production build. AXIS does not also run `vercel deploy
--prod` from GitHub Actions because two deployment owners can race, publish
different revisions, and make rollback evidence ambiguous.

Manual production CLI deploys are incident-recovery actions only. The incident
commander must record the Git revision, Vercel deployment ID, reason, and
recovery owner.

## Committed repository migration manifest

[`scripts/release-migration-manifest.json`](../../scripts/release-migration-manifest.json)
is the complete, committed ledger for the migration tree: each migration's
lexically ordered filename/version and SHA-256 digest, plus the manifest's
count and latest entry. `npm run release:validate` compares it to every tracked
`supabase/migrations/*.sql` file and fails on a missing, changed, extra, or
reordered migration. It also compares the proposed ledger to the immutable
protected-base ledger (or, for this first manifest-introducing change, that
base revision's migration tree): only strict lexical tail additions are
allowed.
Updating the working manifest cannot mask a deletion, rename, rewrite, or
non-tail insertion of a historical migration. If no protected base ref is
available, validation fails closed. In GitHub Actions, the baseline is bound to
immutable event data (`pull_request.base.sha` or `push.before`);
`AXIS_RELEASE_BASE_REF` is rejected. For intentionally offline validation, that
variable may name only an explicit reviewed ancestor—`HEAD`, the current tree,
and unrelated commits are rejected.
Update that manifest in the same reviewed change as any intentional migration
addition; do not rewrite an already-applied migration.
The migration directory is intentionally SQL-only: metadata files, alternate
extensions, symlinks, and nested directories fail validation rather than being
silently omitted from the release inventory.

## Trusted pull-request governance

[`release-governance.yml`](../../.github/workflows/release-governance.yml) uses
`pull_request_target` as a deliberately narrow base-controlled check. It checks
out the immutable base and candidate SHAs into separate directories, installs
only the base revision's dependencies with lifecycle scripts disabled, and
passes the candidate tree to the base revision's validator as inert data. It
never executes candidate code, Actions, dependencies, package scripts, or shell
commands. Permissions are read-only.

The trusted validator parses candidate workflows as YAML (including flow
mappings and nested `run`/`uses` forms), requires every external Action to use a
full 40-character commit SHA plus a readable version comment, rejects direct or
package-script-indirected production Vercel deploys, and compares the candidate
migration ledger to the independently checked-out base tree. The workflow's
closed five-step shape is itself validated so a candidate cannot add an
execution step under the privileged event.

This PR bootstraps that workflow, so GitHub cannot run it from `main` until the
workflow has landed. The subsequent state-refresh PR must receive a green
`release-governance` check before that context is added to required branch
protection.

After this one bootstrap landing, the trusted check freezes the complete
`.github/workflows` directory and the complete critical gate/toolchain surface
byte-for-byte against the protected base:

- the governance validator/core, state derivation/tree-integrity helpers, and
  both layers of the Vercel production-ignore policy;
- `package.json`, `package-lock.json`, `.nvmrc`, and therefore the reviewed
  dependency and tool versions as well as package-script indirection;
- TypeScript, ESLint, Vitest/setup/discovery, Playwright, Electron Playwright,
  Next build configuration, and the complete `vercel.json` deployment
  configuration, with alternate config/package-manager override filenames
  rejected;
- every protected-base unit, browser, and Electron test file byte-for-byte
  (including the complete `tests/` tree), while allowing additive regular test
  files;
- shared and route-isolated bundle budget scripts/config, route-performance
  validation, production postbuild generators, authenticated-E2E bootstrap,
  Supabase E2E configuration, and the SQL grant/contract verifiers.

The complete reviewed `vercel.json` is byte-for-byte protected, and its
`ignoreCommand` is also parsed and required to keep the exact reviewed outer
`sh -c` mapping. Candidate changes to build commands, environment—including
`NODE_OPTIONS`—regions, functions, or other Vercel execution/deployment
semantics therefore require the same owner break-glass process. The Node policy
emits its final build sentinel and exits `73`;
the repository wrapper maps only that pair to `74`; and the inline outer command
maps only wrapper status `74` to Vercel's non-zero build result. Missing or
syntax-invalid wrappers and Node syntax/import/runtime crashes all map to exit
`0` and cancel the deployment. Dependency changes, critical control/test edits,
protected-test path deletion/rename, alternate config injection, and lower
measured unit-test totals/files/suites fail closed. The trusted YAML parser is a direct exact
`js-yaml@4.3.0` development dependency whose root lockfile specifier, registry
URL, version, and integrity are pinned. A generated-only state-refresh candidate
must preserve the base snapshot's complete passing gate evidence byte-for-byte;
trusted base code recomputes the source/base content hashes and evidence
fingerprint.

Existing tests intentionally do not evolve through an ordinary governed PR:
revised coverage is added in a new test file, preserving the reviewed base
suite. The remaining automated boundary is that a new additive test could be
low-value; hosted execution and normal independent review must still assess its
semantic strength.

The state fingerprint proves deterministic consistency, not independent
attestation that commands ran. For source-changing PRs, the frozen workflow and
package-script semantics plus the hosted required checks provide that external
attestation. A state-refresh PR may refresh only provenance, the independently
verified source-main hash, and the resulting fingerprint.

Intentional control-plane changes require an owner break-glass operation:

1. Record the exact files, reason, threat analysis, independent review, and
   rollback in the defect ledger or an ADR.
2. Temporarily bypass the `release-governance` required context for one exact
   reviewed commit through protected-branch administration; do not weaken the
   workflow in an ordinary candidate PR.
3. Restore the required context immediately, confirm its GitHub Actions app
   binding, and require a green base-controlled check on the next PR.

This is an exceptional recovery/update path, not a standing label or
candidate-controlled override.

This inventory is deliberately separate from the historical safety lifecycle
below. The latter remains an explicit expand → application → contract guard for
the July task/approval, WebAuthn, and routine-resume rollout.

## Historical lifecycle release sequence

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

Run `npm run release:validate` before starting. It checks the complete committed
migration manifest, the historical lifecycle's transaction wrappers and safety
markers, read-back scripts, documentation, immutable commit-SHA pins for every
GitHub Action in repository workflows, and that no GitHub workflow owns a
second Vercel production deployment. Deploy-owner detection covers direct and
multiline CLI commands, package-script indirection, and known Vercel deployment
actions; it is intentionally a static guard, not proof that arbitrary shell or
remote action code cannot deploy. It prints the complete ordered digest ledger;
paste that output into the release record.

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
`dad07592`: 1072 Vitest tests across 166 files, clean typecheck/lint,
`release:validate`, a 163-page production build with all 182 route budgets and
4017/4400 KB aggregate static JS, public Playwright 13/13, and authenticated
Playwright 14/14 including auth setup. Hosted expansion migrations are applied
and read back; the contract migration remains intentionally pending.

Production merge remains blocked until the exact final PR head has green CI and
an isolated Vercel preview workflow (now passed with a disposable hosted user),
a Sentry operator records the release- and environment-scoped Issues result,
required provider/manual security checks are
signed off, merge authorization is explicit, and the post-live contract stage
has a named recovery owner.
