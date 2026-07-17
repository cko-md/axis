-- 202607140100_routine_runs.sql
-- Durable routine execution (program §15.5), backing src/lib/routines/runState.ts.
-- New tables, additive, touch no existing data. A routine_run records one
-- execution of a routine; routine_step_runs record each durable step with its
-- input/output snapshots so a run is inspectable, resumable, and auditable.
-- Status values are enforced in application code via runState (assert*), and by
-- these check constraints as a backstop.

create table if not exists public.routine_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  routine_key text not null,
  routine_version integer not null default 1,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_for_approval', 'blocked', 'completed', 'partial', 'failed', 'cancelled')),
  trigger text not null default 'manual',
  input_snapshot jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  estimated_cost_usd numeric,
  actual_cost_usd numeric,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.routine_runs enable row level security;

drop policy if exists "routine_runs_select_own" on public.routine_runs;
create policy "routine_runs_select_own" on public.routine_runs for select using (auth.uid() = user_id);
drop policy if exists "routine_runs_insert_own" on public.routine_runs;
create policy "routine_runs_insert_own" on public.routine_runs for insert with check (auth.uid() = user_id);
drop policy if exists "routine_runs_update_own" on public.routine_runs;
create policy "routine_runs_update_own" on public.routine_runs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No delete policy: runs are an audit trail.

create index if not exists idx_routine_runs_user_started
  on public.routine_runs (user_id, started_at desc);

create table if not exists public.routine_step_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.routine_runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  step_key text not null,
  ordinal integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  input_snapshot jsonb,
  output_snapshot jsonb,
  error text,
  attempt integer not null default 1,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.routine_step_runs enable row level security;

drop policy if exists "routine_step_runs_select_own" on public.routine_step_runs;
create policy "routine_step_runs_select_own" on public.routine_step_runs for select using (auth.uid() = user_id);
drop policy if exists "routine_step_runs_insert_own" on public.routine_step_runs;
create policy "routine_step_runs_insert_own" on public.routine_step_runs for insert with check (auth.uid() = user_id);
drop policy if exists "routine_step_runs_update_own" on public.routine_step_runs;
create policy "routine_step_runs_update_own" on public.routine_step_runs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_routine_step_runs_run
  on public.routine_step_runs (run_id, ordinal);
