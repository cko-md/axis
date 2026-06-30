# Widget Cache Architecture

Date: 2026-06-30
Issue: WID-DATA-1

## Purpose

`widget_cache` is the Supabase-backed last-known-state table for Console widgets. It exists so later widget work can render cached values first and revalidate providers in the background without blanking the Console when one provider is slow or down.

Runtime code does not read or write this table in WID-DATA-1. The batch endpoint and cache-first loading belong to later issues.

## Migration Ordering

The inspected repo still has inconsistent migration naming:

- Numeric migrations run through `049_`.
- Some older inserts use non-sequential names such as `0281_` and `0301_`.
- Newer migrations use timestamp names such as `202606300901_...` and `202606301001_...`.

To avoid adding another ambiguous numeric prefix, WID-DATA-1 uses:

`supabase/migrations/202606302157_widget_cache.sql`

This is additive and sorts after the existing `20260630...` migrations.

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

## Supabase Impact

Adds one non-destructive table and one index:

- `public.widget_cache`
- `idx_widget_cache_user_expires`

The table references `auth.users(id)` with `on delete cascade`.

## Tembo Impact

Tembo role is unspecified in inspected repo config. This change does not route data to Tembo and does not assume Tembo is primary Postgres, analytics Postgres, queue, cache, or unused.

## Follow-up Issues

- WID-DATA-2: add `/api/widgets/batch`.
- WID-DATA-3: read cached widget states before provider refresh and write fresh states back to `widget_cache`.
