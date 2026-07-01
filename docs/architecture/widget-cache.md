# Widget Cache Architecture

Date: 2026-06-30
Issue: WID-DATA-1

## Purpose

`widget_cache` is the Supabase-backed last-known-state table for Console widgets. It exists so the Console can render cached values first and revalidate providers in the background without blanking the surface when one provider is slow or down.

Runtime status as of the Phase 3 stack:

- `src/lib/hooks/useWidgetData.ts` reads `public.widget_cache` before provider refresh.
- `src/app/api/widgets/batch/route.ts` writes fresh widget states to `public.widget_cache`.
- Individual widget endpoints still own provider-specific fetch behavior and safe fallback payloads.

## Migration Ordering

The inspected repo still has inconsistent migration naming:

- Numeric migrations run through `049_`.
- Some older inserts use non-sequential names such as `0281_` and `0301_`.
- Newer migrations use timestamp names such as `202606300901_...` and `202606301001_...`.

To avoid adding another ambiguous numeric prefix, WID-DATA-1 uses:

`supabase/migrations/202606302157_widget_cache.sql`

This is additive and sorts after the existing `20260630...` migrations. Do not assume it has been applied to a target environment until the production gate verifies it.

## Table Shape

Primary key:

- `user_id`
- `widget_id`
- `cache_key`

Columns:

- `status`
- `value`
- `hint`
- `raw`
- `error`
- `fetched_at`
- `expires_at`
- `updated_at`

`raw` and `error` must only contain sanitized widget metadata that is safe for the owning user. Do not store tokens, OAuth payloads, private message content, email bodies, or raw provider responses.

## RLS

RLS is enabled on `public.widget_cache`.

Policies are owner-scoped:

- select own rows
- insert own rows
- update own rows
- delete own rows

Every policy uses `auth.uid() = user_id`.

## Validation SQL

Run these checks against the target Supabase project before production merge:

```sql
select to_regclass('public.widget_cache') as widget_cache_table;

select
  schemaname,
  tablename,
  rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename = 'widget_cache';

select
  policyname,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'widget_cache'
order by policyname;

select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'widget_cache'
order by indexname;
```

Expected result:

- `widget_cache_table` is `widget_cache`.
- `rowsecurity` is `true`.
- Select, insert, update, and delete policies exist and are owner-scoped with `auth.uid() = user_id`.
- The primary key covers `(user_id, widget_id, cache_key)`.
- `idx_widget_cache_user_expires` exists.

## Supabase Impact

Adds one non-destructive table and one index:

- `public.widget_cache`
- `idx_widget_cache_user_expires`

The table references `auth.users(id)` with `on delete cascade`.

## Tembo Impact

Tembo role is unspecified in inspected repo config. This change does not route data to Tembo and does not assume Tembo is primary Postgres, analytics Postgres, queue, cache, or unused.

## Runtime Boundaries

- `raw` stores normalized widget metadata only, not raw provider responses.
- `error` stores structured, sanitized error metadata only.
- Do not store tokens, OAuth payloads, private message content, email bodies, note bodies, health payloads, contact PII, financial account data, or full provider responses in this table.
- Cache writes are best-effort; a cache write failure should be captured with safe metadata and must not break the user-facing widget response.

## Follow-up Issues

- WID-DATA-4: refine stale-while-revalidate behavior and per-widget freshness UI.
- WID-DATA-5: expand widget provider observability and cache write failure visibility.
