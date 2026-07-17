-- Phase 8: inspectable user memory + financial operating profile.
-- Memory is context only. It never grants authority for approvals or execution.

create table if not exists public.memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('preference', 'constraint', 'goal', 'context')),
  scope text not null check (scope in ('global', 'financial', 'routine', 'integration')),
  content text not null check (char_length(btrim(content)) between 1 and 1200),
  source_type text not null default 'user_asserted'
    check (source_type in ('user_asserted', 'provider_import', 'system_observed')),
  source_ref text check (source_ref is null or char_length(source_ref) between 1 and 200),
  confidence_bps integer not null default 10000 check (confidence_bps between 0 and 10000),
  status text not null default 'active' check (status in ('active', 'archived')),
  expires_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'archived') = (archived_at is not null))
);

create index if not exists memory_items_user_status_updated_idx
  on public.memory_items (user_id, status, updated_at desc);
create index if not exists memory_items_user_scope_idx
  on public.memory_items (user_id, scope, updated_at desc);

alter table public.memory_items enable row level security;

drop policy if exists memory_items_select_own on public.memory_items;
create policy memory_items_select_own on public.memory_items
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists memory_items_insert_own on public.memory_items;
create policy memory_items_insert_own on public.memory_items
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists memory_items_update_own on public.memory_items;
create policy memory_items_update_own on public.memory_items
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists memory_items_delete_own on public.memory_items;

revoke all on public.memory_items from anon;
revoke all on public.memory_items from authenticated;
grant select, insert, update on public.memory_items to authenticated;
grant all on public.memory_items to service_role;

create table if not exists public.financial_operating_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  base_currency text not null default 'USD'
    check (base_currency ~ '^[A-Z]{3}$'),
  risk_posture text not null default 'balanced'
    check (risk_posture in ('capital_preservation', 'conservative', 'balanced', 'growth', 'aggressive')),
  investment_horizon text not null default 'long_term'
    check (investment_horizon in ('under_3_years', '3_to_7_years', '7_to_15_years', 'long_term')),
  liquidity_buffer_months integer not null default 6
    check (liquidity_buffer_months between 0 and 120),
  concentration_limit_bps integer not null default 2000
    check (concentration_limit_bps between 100 and 10000),
  priorities text[] not null default '{}'::text[]
    check (cardinality(priorities) <= 8 and char_length(array_to_string(priorities, E'\n')) <= 640),
  constraints text[] not null default '{}'::text[]
    check (cardinality(constraints) <= 12 and char_length(array_to_string(constraints, E'\n')) <= 1920),
  source_type text not null default 'user_asserted' check (source_type = 'user_asserted'),
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.financial_operating_profiles enable row level security;

drop policy if exists financial_operating_profiles_select_own on public.financial_operating_profiles;
create policy financial_operating_profiles_select_own on public.financial_operating_profiles
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists financial_operating_profiles_insert_own on public.financial_operating_profiles;
create policy financial_operating_profiles_insert_own on public.financial_operating_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists financial_operating_profiles_update_own on public.financial_operating_profiles;
create policy financial_operating_profiles_update_own on public.financial_operating_profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists financial_operating_profiles_delete_own on public.financial_operating_profiles;

revoke all on public.financial_operating_profiles from anon;
revoke all on public.financial_operating_profiles from authenticated;
grant select, insert, update on public.financial_operating_profiles to authenticated;
grant all on public.financial_operating_profiles to service_role;
