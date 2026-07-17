-- 005_training_sessions.sql
-- Editable 7-day training-week planner for the Vitality module.
-- DO NOT APPLY blindly — review against the live project before running.
-- Mirrors the RLS / ownership conventions of tasks (001_initial.sql) and
-- fund_transactions (004). One row per session; a "week" is the set of rows a
-- user owns. `dow` is 0=Mon … 6=Sun to match the planner column order.

create table if not exists public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  dow smallint not null check (dow between 0 and 6),       -- 0=Mon … 6=Sun
  -- 'run' | 'lift' | 'mobility' | 'rest' | 'other'
  kind text not null default 'run'
    check (kind in ('run', 'lift', 'mobility', 'rest', 'other')),
  title text not null default '',
  duration_min integer not null default 0,                 -- planned minutes
  -- 'easy' | 'moderate' | 'hard' | 'key'  (intensity / emphasis)
  intensity text not null default 'moderate'
    check (intensity in ('easy', 'moderate', 'hard', 'key')),
  notes text,
  completed boolean not null default false,
  sort_order integer not null default 0,                   -- order within a day
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.training_sessions enable row level security;

create policy "training_sessions_select_own"
  on public.training_sessions for select using (auth.uid() = user_id);
create policy "training_sessions_insert_own"
  on public.training_sessions for insert with check (auth.uid() = user_id);
create policy "training_sessions_update_own"
  on public.training_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "training_sessions_delete_own"
  on public.training_sessions for delete using (auth.uid() = user_id);

create index if not exists idx_training_sessions_user
  on public.training_sessions (user_id, dow, sort_order);
