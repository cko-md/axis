-- 202607131701_tasks_table.sql
-- DRAFT — DO NOT APPLY blindly. Pending human + RLS review before running
-- against any Supabase target. Backs the pure state machine in
-- src/lib/tasks/taskState.ts (wave 8.1 of docs/axis-redesign) — a new table,
-- so it is additive and touches no existing data.
--
-- The durable agent-Task: the canonical, resumable unit of agent work (Town's
-- shared-Task model, adapted). `status` must only ever be moved through
-- transitions legal under TASK_TRANSITIONS in src/lib/tasks/taskState.ts —
-- enforced in application code (assertTransition), not by a DB trigger, so the
-- rule stays in one typed, tested place.

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  objective text not null,
  status text not null default 'queued'
    check (status in (
      'queued', 'gathering_data', 'researching', 'calculating',
      'waiting_for_data', 'waiting_for_user', 'waiting_for_approval',
      'executing', 'blocked', 'completed', 'failed', 'cancelled'
    )),
  -- Free-form context the task carries across pauses: initiating event,
  -- connected entity ids, source data references, current step, open
  -- questions. Kept as jsonb rather than a rigid schema because task shapes
  -- vary by skill/routine; validate shape in application code, not SQL.
  context jsonb not null default '{}'::jsonb,
  -- Which routine/skill produced this task, if any (nullable: tasks can also
  -- be created directly by a user or by chat).
  source_routine_id uuid,
  source_skill text,
  -- Denormalized cost tracking (see src/lib/security/actionPolicy.ts for the
  -- action-class model that approvals on this task must satisfy).
  estimated_cost_usd numeric,
  actual_cost_usd numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own"
  on public.tasks for select using (auth.uid() = user_id);
drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own"
  on public.tasks for insert with check (auth.uid() = user_id);
drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own"
  on public.tasks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own"
  on public.tasks for delete using (auth.uid() = user_id);

create index if not exists idx_tasks_user_status
  on public.tasks (user_id, status, updated_at desc);

-- Append-only activity/evidence log for a task (agent actions, tool calls,
-- evidence gathered, status transitions). Kept separate from `tasks` so the
-- task row stays small and the log can be queried/paginated independently.
create table if not exists public.task_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null
    check (kind in ('status_change', 'tool_call', 'evidence', 'note', 'approval_request', 'approval_decision')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.task_activity enable row level security;

drop policy if exists "task_activity_select_own" on public.task_activity;
create policy "task_activity_select_own"
  on public.task_activity for select using (auth.uid() = user_id);
drop policy if exists "task_activity_insert_own" on public.task_activity;
create policy "task_activity_insert_own"
  on public.task_activity for insert with check (auth.uid() = user_id);
-- No update/delete policy: activity is append-only / immutable audit trail.

create index if not exists idx_task_activity_task
  on public.task_activity (task_id, created_at);

-- Review checklist before applying:
--   1. Confirm target Supabase project.
--   2. `supabase db diff` against a shadow DB.
--   3. Confirm the `status` check constraint stays in sync with
--      src/lib/tasks/taskState.ts TASK_STATUSES if that list ever changes.
--   4. Confirm task_activity's append-only (no update/delete policy) is the
--      desired audit posture before applying.
--   5. Apply via the project's standard Supabase migration flow.
