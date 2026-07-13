-- 202607131701_tasks_table.sql
-- Backs the pure state machine in src/lib/tasks/taskState.ts (wave 8.1 of
-- docs/axis-redesign) — new tables, additive, touches no existing data.
--
-- NAMING NOTE (defect TASK-collision, caught during pre-apply DB inspection):
-- public.tasks ALREADY EXISTS in this database as the user's to-do / Agenda
-- task table (title/priority/effort/deadline/sort_order — used by useTasks,
-- Debrief reminders, etc.). The redesign's "durable agent-Task" is a distinct
-- concept, so these tables are namespaced `agent_*` to avoid colliding with,
-- shadowing, or (via `if not exists`) silently no-opping against that table.
--
-- The durable agent-Task: the canonical, resumable unit of agent work (Town's
-- shared-Task model, adapted). `status` must only ever be moved through
-- transitions legal under TASK_TRANSITIONS in src/lib/tasks/taskState.ts —
-- enforced in application code (assertTransition), not by a DB trigger, so the
-- rule stays in one typed, tested place.

create table if not exists public.agent_tasks (
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

alter table public.agent_tasks enable row level security;

drop policy if exists "agent_tasks_select_own" on public.agent_tasks;
create policy "agent_tasks_select_own"
  on public.agent_tasks for select using (auth.uid() = user_id);
drop policy if exists "agent_tasks_insert_own" on public.agent_tasks;
create policy "agent_tasks_insert_own"
  on public.agent_tasks for insert with check (auth.uid() = user_id);
drop policy if exists "agent_tasks_update_own" on public.agent_tasks;
create policy "agent_tasks_update_own"
  on public.agent_tasks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "agent_tasks_delete_own" on public.agent_tasks;
create policy "agent_tasks_delete_own"
  on public.agent_tasks for delete using (auth.uid() = user_id);

create index if not exists idx_agent_tasks_user_status
  on public.agent_tasks (user_id, status, updated_at desc);

-- Append-only activity/evidence log for a task (agent actions, tool calls,
-- evidence gathered, status transitions). Kept separate from `agent_tasks` so
-- the task row stays small and the log can be queried/paginated independently.
create table if not exists public.agent_task_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null
    check (kind in ('status_change', 'tool_call', 'evidence', 'note', 'approval_request', 'approval_decision')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.agent_task_activity enable row level security;

drop policy if exists "agent_task_activity_select_own" on public.agent_task_activity;
create policy "agent_task_activity_select_own"
  on public.agent_task_activity for select using (auth.uid() = user_id);
drop policy if exists "agent_task_activity_insert_own" on public.agent_task_activity;
create policy "agent_task_activity_insert_own"
  on public.agent_task_activity for insert with check (auth.uid() = user_id);
-- No update/delete policy: activity is append-only / immutable audit trail.

create index if not exists idx_agent_task_activity_task
  on public.agent_task_activity (task_id, created_at);

-- Review checklist before applying:
--   1. Confirm target Supabase project.
--   2. `supabase db diff` against a shadow DB.
--   3. Confirm the `status` check constraint stays in sync with
--      src/lib/tasks/taskState.ts TASK_STATUSES if that list ever changes.
--   4. Confirm agent_task_activity's append-only (no update/delete policy) is
--      the desired audit posture before applying.
--   5. Apply via the project's standard Supabase migration flow.
