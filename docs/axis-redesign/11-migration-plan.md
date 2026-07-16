# 11 — Database migration plan

AXIS uses Supabase Postgres as the application database. Migrations are
additive-first, owner-scoped, and verified locally and on the intended hosted
project before production merge. The repository has historical migration
ordering defects, so filename presence is never treated as proof that a target
applied the schema.

This document defines the database mechanics. Deployment sequencing and owner
sign-off are detailed in [`12-release-plan.md`](12-release-plan.md).

## Principles

- Never edit the semantics of a migration already applied to a shared target.
  Add a forward migration.
- Prefer nullable columns/new tables/new RPCs and compatibility behavior before
  revoking an old path.
- Every user-owned row has `user_id`, RLS, owner policies, explicit grants, and
  indexes matching the owner access path.
- Every `SECURITY DEFINER` function has a fixed empty `search_path`, validates
  owner/referenced rows internally, and grants execute only to the minimum role.
- Audit records are append-only/no-delete where practical.
- Schema changes and application changes are released as expand → application →
  contract. The old application must work throughout expansion.
- No destructive cleanup occurs until the replacement has run in production and
  rollback/data-retention requirements are satisfied.

## Historical ordering caveat

The project migration ledger contains numeric and timestamp-style history, and
older checkouts had a duplicate `011` version plus a policy recreation conflict.
The current tree resolves fresh-replay ordering with
`011_avatars_bucket.sql`, `0111_cleanup_functions.sql`, and an explicit policy
drop before recreation. CI now treats a clean local Supabase replay as a gate.
Hosted targets may still have a different historical ledger, so never infer
their state from filenames alone or repair history without catalog read-back.

Every release must therefore establish both:

1. **fresh-stack behavior** — the CI/local procedure can construct a usable
   database from the repository history or uses the documented non-mutating
   compatibility procedure; and
2. **target behavior** — the hosted project receives only the reviewed new
   migration files and passes exact schema/grant/RLS read-back.

If either cannot be proven, production is blocked and the missing command,
target, and validation owner are recorded.

## Current expansion/application/contract wave

The dependency order is lexical and semantic:

| Stage | Version/file | Purpose |
|---|---|---|
| Expansion 1 | [`202607161300_task_approval_atomic.sql`](../../supabase/migrations/202607161300_task_approval_atomic.sql) | Atomic Task creation/transition and approval creation/decision/consumption, complete-scope validation, audit coupling, compatibility grants. |
| Expansion 2 | [`202607161302_webauthn_atomic.sql`](../../supabase/migrations/202607161302_webauthn_atomic.sql) | Exact one-time WebAuthn challenge consumption, passkey creation/counter commit/deletion, service-only ceremony RPCs. |
| Expansion 3 | [`202607161400_routine_resume_claims.sql`](../../supabase/migrations/202607161400_routine_resume_claims.sql) | Fenced routine resume leases/steps, atomic terminal approval consumption, task idempotency, compatibility policies. |
| Application | Compatible application revision | Routes use the atomic RPCs and no longer depend on direct browser Task/approval/passkey writes. Vercel Git integration is the sole production deploy owner. |
| Contract | [`202607161401_task_approval_lockdown.sql`](../../supabase/migrations/202607161401_task_approval_lockdown.sql) | Removes legacy authenticated Task/approval/passkey insert/update/delete policies/grants, replaces the passkey `FOR ALL` policy with owner SELECT only, and runs only after the compatible application is confirmed live. |

The contract migration must never run merely because the preview is green. It
runs only after the compatible revision is on production, expansion checks are
green, recovery ownership is named, and explicit contract approval is recorded.

The release manifest is validated by
[`validate-release-wave.mjs`](../../scripts/validate-release-wave.mjs):

```bash
npm run release:validate
npm run release:validate -- --stage=expand
npm run release:validate -- \
  --stage=contract \
  --expansions-verified \
  --contract-approved \
  --app-live-revision=<production-sha> \
  --recovery-owner=<incident-owner>
```

## Local verification

For a schema wave:

1. start the local Supabase/Docker stack documented in
   [`AGENTS.md`](../../AGENTS.md);
2. apply the new migrations in exact filename order with stop-on-error;
3. apply them again where the migration is designed to be idempotent;
4. run database lint/catalog checks;
5. run two-user RLS/grant probes and concurrent RPC validators;
6. run the authenticated browser suite against the resulting database;
7. stop/remove temporary users and validation rows.

Current focused validators:

```bash
node scripts/validate-task-approval-cas.mjs --local
node scripts/validate-webauthn-atomic.mjs --local
node scripts/validate-routine-resume-claims.mjs --local
```

The checks cover exact-one-winner races, terminal immutability, malformed scope,
backdating, WebAuthn replay/counter races, owner isolation, direct browser DML
denial, stale claim fencing, idempotent task creation, and atomic approval/run
completion.

## Hosted expansion

Before deploying the application:

1. confirm the linked project id and active health;
2. capture the current migration-history/catalog state;
3. checksum the reviewed migration files;
4. apply only the three expansion files in order using an explicit linked
   `db query --file` or equivalent controlled API;
5. run [`verify-20260716-expand.sql`](../../scripts/sql/verify-20260716-expand.sql);
6. run owner-isolation/role-grant checks in rollback transactions;
7. record project, timestamps, checksums, results, and operator.

Do not use an indiscriminate `db push --include-all` while historical ordering
is ambiguous. Do not mark a migration-history version repaired/applied until the
schema and grants have been read back and match the reviewed file.

Expansion verification must confirm:

- required tables/columns/constraints/indexes exist;
- RLS is enabled;
- `anon` and `authenticated` lack service-only RPC execution;
- legacy compatibility grants are exactly those expected during expansion;
- RPC owners/search paths/grants are correct;
- old and new application access paths remain functional until application
  deployment.

## Application deployment and compatibility window

Merge deploys through Vercel Git integration. During the compatibility window:

- monitor route errors, permission failures, RPC conflicts, WebAuthn failures,
  routine-resume outcomes, and database latency;
- exercise Tasks, Approvals, passkey settings/login, routine pause/resume, and
  related navigation on production with non-destructive data;
- keep the expansion schema in place if the application must be rolled back;
- do not apply the contract migration while any production instance still uses
  a legacy direct-write path.

An application rollback before contract is a normal code rollback; the additive
schema remains.

## Hosted contract

After the production revision and external gates are verified:

1. run the contract-stage release validator with the live SHA, explicit approval,
   and recovery owner;
2. apply only
   [`202607161401_task_approval_lockdown.sql`](../../supabase/migrations/202607161401_task_approval_lockdown.sql);
3. run [`verify-20260716-contract.sql`](../../scripts/sql/verify-20260716-contract.sql);
4. prove authenticated direct Task/activity/approval/passkey writes fail while
   service RPC paths still work; the verifier performs real authenticated
   passkey insert/update/delete denial probes in addition to catalog checks;
5. repeat owner-isolation and core production smoke checks;
6. record post-contract Sentry/Vercel/database evidence.

After contract, an old application that depends on revoked direct writes is not
a valid rollback. Recovery is forward-fix or redeploy of a compatible revision.
The contract migration removes permissions, not data, so no user-data restore
should be necessary.

## RLS and grant review checklist

For every new/changed table:

- `user_id` ownership and foreign keys have the intended delete behavior;
- RLS is enabled before client grants;
- policies are command-specific and owner-scoped;
- table/column grants do not expose ciphertext, tokens, hashes, claims, raw
  payloads, or private provider data;
- anonymous access is absent unless explicitly public;
- audit tables lack delete access;
- service role has only the access required by server routes/jobs.

For every new/changed function:

- signature and overloads are unambiguous;
- `SECURITY DEFINER` is justified;
- fixed empty `search_path`;
- owner/ref validation occurs inside the transaction;
- expected-state/lease/idempotency checks are atomic;
- execute is revoked from `public`, `anon`, and `authenticated` unless a narrow
  authenticated RPC deliberately derives `auth.uid()`;
- service-role grant is explicit;
- replay, foreign-owner, malformed, and concurrent calls are tested.

## Generated types and application compatibility

Update [`database.types.ts`](../../src/lib/supabase/database.types.ts) in the
same wave with the smallest reviewed diff or regenerate it from the verified
schema. Type artifacts do not prove migration application; runtime catalog
read-back remains authoritative. Application reads must tolerate expansion-era
nullable/defaulted fields until the contract phase.

## Rollback, forward repair, and data safety

- Prefer forward repair migrations. Never `git reset`, drop a production table,
  or rewrite migration history to recover.
- Expansion rollback normally means reverting application behavior while
  retaining additive schema.
- A bad RPC/grant is corrected by a new transaction-wrapped migration and
  reverified.
- A contract rollback restores only the minimum reviewed grants/policies through
  a new migration; it does not restore unsafe broad permissions by hand.
- Before any future destructive cleanup, export/retain affected audit data,
  prove no active application dependency, and obtain explicit owner approval.

## Tembo

No runtime client, connection, migration target, or data path in the inspected
repository assigns Tembo a role. Supabase is the application source of truth for
this plan. No migration is applied to Tembo and no AXIS data is replicated there.
Using Tembo later requires an explicit owner decision that names its role,
allowed data classes, privacy/RLS model, migration tooling, validation owner,
and recovery procedure.
