-- 20260715224141_routine_run_pause_metadata.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live schema (information_schema
-- + pg_indexes) on 20260715224156's sibling routine_runs columns.
--
-- Adds the pause/approval-gate metadata a routine_run needs when it stops to
-- wait on an approval mid-run: which step it paused at, which approval gates
-- resumption, and the idempotency key to dedupe a resumed step.

alter table public.routine_runs
  add column if not exists paused_step_key text,
  add column if not exists approval_id uuid,
  add column if not exists idempotency_key text;

create unique index if not exists idx_routine_runs_user_idempotency_key
  on public.routine_runs (user_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_routine_runs_user_waiting_approval
  on public.routine_runs (user_id, status, approval_id)
  where approval_id is not null;
