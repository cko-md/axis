# AXIS Migration And Deployment Truth Probe - 2026-07-01

> Issue: DATA-0 - Migration and deployment truth probe  
> Scope: documentation-only inspection of migration ordering, Supabase project metadata, Tembo references, CLI/tool availability, Vercel deployment configuration, and Sentry validation hooks.  
> No schema, runtime, env, or deployment changes were made.

## Summary

AXIS has a linked Supabase project metadata file and a local Supabase config, but this shell does not have the Supabase CLI, Vercel CLI, or Sentry CLI available. The repo evidence is enough to document migration/deploy risk, but not enough to claim remote migration state, preview validation, or Sentry cleanliness.

Tembo role is unspecified in inspected repo config. Existing Tembo mentions are planning/audit notes only; no runtime code or env template routes data to Tembo.

## Tool Availability

| Tool | Local availability | Evidence | Impact |
|---|---|---|---|
| GitHub CLI | Available | `gh` exists and can create PRs. | Branch/PR automation available. |
| Supabase CLI | Not found in PATH | `command -v supabase` returned no path. | Cannot run `supabase migration list`, `supabase db push`, `supabase db reset`, or branch validation from this shell. |
| Vercel CLI | Not found in PATH | `command -v vercel` returned no path. | Cannot query preview/prod deployments from this shell. |
| Sentry CLI | Not found in PATH | `command -v sentry-cli` returned no path. | Cannot query Sentry from this shell without connector/CLI access. |

## Supabase Project Evidence

`supabase/project.json` identifies the linked project:

```text
project_id: twkcvyhmlguipchfetge
project_name: Axis[CKO] v2
organization: KnockOut Digital
region: us-east-1
dashboard_url: https://supabase.com/dashboard/project/twkcvyhmlguipchfetge
api_url: https://twkcvyhmlguipchfetge.supabase.co
```

`supabase/config.toml` local project id is `axis`, with local Postgres major version 17 and migrations enabled.

## Migration Filename State

Current migration files are unique, but not uniformly named:

- Sequential numeric files run from `001_initial.sql` through `049_literature_watch_tracking.sql`.
- Decimal-like numeric names exist: `0281_relocate_vector_trgm_extensions.sql`, `0301_fitness_routines.sql`, `0302_library_files.sql`, `0303_moodboard_images.sql`, and `0304_nutrition_protocol.sql`.
- Timestamped files exist after the numeric sequence: `202606300901_literature_saved_notes_tags.sql`, `202606301001_debrief_entries.sql`, and `202606302157_widget_cache.sql`.

Current sorted order means `0281_...` sorts after `028_...` and before `029_...`; `0301_...` through `0304_...` sort after `030_...` and before `031_...`; timestamped migrations sort after all numeric migrations. That order may be intentional, but it is not the standard Supabase CLI timestamp convention for the whole set and should be validated before any new schema work.

## Remote Applied-State Gap

Remote applied migration state was not validated because Supabase CLI/API/connector access is unavailable in this shell. Do not assume any local migration, including `202606302157_widget_cache.sql`, is applied in the target Supabase project until one of these checks succeeds:

```bash
supabase migration list --project-ref twkcvyhmlguipchfetge
supabase db push --dry-run --project-ref twkcvyhmlguipchfetge
```

If using a connector instead of the CLI, list remote migrations for project `twkcvyhmlguipchfetge` and compare against `supabase/migrations`.

## Tembo Findings

Repo search found no `TEMBO_*` env vars, Tembo client library, non-Supabase Postgres client, or runtime code path using Tembo. Existing Tembo references appear in docs and agent instructions as a validation concern.

Current statement:

```text
Tembo role is unspecified.
```

Until the human owner confirms otherwise, treat Supabase Postgres as the primary persistence layer and route no data to Tembo.

Human questions before any Tembo-related implementation:

- Is Tembo provisioned for AXIS at all?
- If yes, is it primary Postgres, analytics Postgres, queue/cache, an experiment, or unused?
- Are any Tembo connection strings present in Vercel or another secret manager?
- What data classes, if any, may be copied to Tembo? Mail bodies, contact PII, health payloads, financial data, OAuth payloads, and note bodies must not be routed there without explicit approval.

## Deployment Configuration

`vercel.json` configures:

- framework: `nextjs`
- build command: `npm run build`
- output directory: `.next`
- region: `iad1`
- scheduled cron routes:
  - `/api/cron/daily` at `0 6 * * *`
  - `/api/cron/finance-daily` at `0 22 * * *`

Additional cron routes exist in code but are not scheduled in `vercel.json`:

- `/api/cron/feed-digest`
- `/api/cron/intelligence-sweep`

`.github/workflows/deploy.yml` deploys to Vercel production on pushes to `main` using:

```bash
npx vercel deploy --prod --token=${{ secrets.VERCEL_TOKEN }}
```

with `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` set in the workflow. Confirm whether Vercel Git integration is also active before merging to production, so the team knows whether one or two production deploy mechanisms may run.

## Production Readiness Gate

Before merging any runtime or schema PR:

1. Local checks pass: `npx tsc --noEmit`, `npm run lint`, `npm run test`; run `npm run build` for runtime behavior changes.
2. Vercel preview deploy is green.
3. Manual happy/error paths are validated on the preview URL.
4. Supabase impact is explicit:
   - no migration, or
   - migration applied/verified against the target/branch project with applied-state evidence.
5. Tembo impact says either `Tembo role is unspecified` or records the confirmed role and data boundary.
6. Sentry is reviewed after preview interaction for new errors/regressions in the preview window.
7. Human approval is given before merge.

## Manual Validation Steps For Missing Access

If the agent still lacks Supabase/Vercel/Sentry tooling on a future PR, record these exact owner-run checks in the PR:

```bash
# Supabase migration state
supabase migration list --project-ref twkcvyhmlguipchfetge

# For schema PRs only, on a branch/throwaway target first
supabase db reset
supabase db push --dry-run --project-ref twkcvyhmlguipchfetge

# Vercel preview/prod evidence
gh pr view <PR_NUMBER> --json statusCheckRollup

# Sentry review
# Use Sentry project dashboard or CLI/connector to query new issues in the preview deploy window.
```

## Follow-Up Issues

- PROD-1: migration ordering and replay audit on a fresh/branch Supabase target.
- PROD-3: RLS verification for user-owned tables, including `widget_cache`.
- PROD-5: Sentry/Vercel production gate automation.
- OBS-CRON-1: decide whether `feed-digest` and `intelligence-sweep` should be scheduled or explicitly manual-only.
