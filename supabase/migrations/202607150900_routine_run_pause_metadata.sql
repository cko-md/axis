-- 202607150900_routine_run_pause_metadata.sql
-- Phase 9a: resume-after-approval metadata for durable routine runs.
--
-- Additive only. Existing routine_runs RLS remains owner-scoped for select,
-- insert, and update; there is still no delete policy because runs are an audit
-- trail. The composite FK prevents linking a run to another user's approval.

alter table public.routine_runs
  add column if not exists paused_step_key text,
  add column if not exists approval_id uuid,
  add column if not exists idempotency_key text;

create unique index if not exists idx_approvals_id_user
  on public.approvals (id, user_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routine_runs_approval_owner_fkey'
  ) then
    alter table public.routine_runs
      add constraint routine_runs_approval_owner_fkey
      foreign key (approval_id, user_id)
      references public.approvals (id, user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routine_runs_pause_metadata_pair_check'
  ) then
    alter table public.routine_runs
      add constraint routine_runs_pause_metadata_pair_check
      check (
        (paused_step_key is null and approval_id is null)
        or
        (paused_step_key is not null and approval_id is not null)
      );
  end if;
end $$;

create index if not exists idx_routine_runs_user_waiting_approval
  on public.routine_runs (user_id, status, approval_id)
  where approval_id is not null;

create unique index if not exists idx_routine_runs_user_idempotency_key
  on public.routine_runs (user_id, idempotency_key)
  where idempotency_key is not null;
