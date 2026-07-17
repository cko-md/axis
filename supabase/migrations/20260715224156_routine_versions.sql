-- 20260715224156_routine_versions.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live schema (information_schema,
-- pg_indexes, pg_policies) on 2026-07-17.
--
-- Versioned, user-editable routine definitions (program §15.5) — a
-- routine_key can have multiple routine_versions rows (draft/active/
-- archived), with at most one 'active' version per (user_id, routine_key).

create table if not exists public.routine_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  routine_key text not null,
  routine_version integer not null,
  name text not null,
  description text not null default '',
  definition jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  source_version_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.routine_versions enable row level security;

drop policy if exists "routine_versions_select_own" on public.routine_versions;
create policy "routine_versions_select_own" on public.routine_versions for select using (auth.uid() = user_id);
drop policy if exists "routine_versions_insert_own" on public.routine_versions;
create policy "routine_versions_insert_own" on public.routine_versions for insert with check (auth.uid() = user_id);
drop policy if exists "routine_versions_update_own" on public.routine_versions;
create policy "routine_versions_update_own" on public.routine_versions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No delete policy: versions are an audit trail (archive via status instead).

create unique index if not exists idx_routine_versions_user_key_version
  on public.routine_versions (user_id, routine_key, routine_version);

create unique index if not exists idx_routine_versions_one_active
  on public.routine_versions (user_id, routine_key)
  where status = 'active';

create index if not exists idx_routine_versions_user_key_created
  on public.routine_versions (user_id, routine_key, created_at desc);
