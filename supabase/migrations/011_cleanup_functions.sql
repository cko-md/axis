-- Maintenance functions called from the internal cron route (/api/cron or pg_cron).
-- Both run as SECURITY DEFINER so they bypass RLS and operate across all users.
-- Granted to the authenticated role so the cron API route can invoke them directly.

-- ─── mark_overdue_tasks ────────────────────────────────────────────────────────
-- Flips tasks from 'open' → 'overdue' when the deadline has passed.
-- Skips tasks that are already 'done' or 'overdue'.
-- Returns the number of rows updated.

create or replace function public.mark_overdue_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.tasks
  set
    status     = 'overdue',
    updated_at = now()
  where
    status   = 'open'
    and deadline is not null
    and deadline < now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ─── cleanup_old_signals ───────────────────────────────────────────────────────
-- Deletes signals that have been routed (routed_at is not null) and are older
-- than 60 days. Unrouted signals are never deleted by this function.
-- Returns the number of rows deleted.

create or replace function public.cleanup_old_signals()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.signals
  where
    routed_at is not null
    and created_at < now() - interval '60 days';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ─── grants ────────────────────────────────────────────────────────────────────
grant execute on function public.mark_overdue_tasks()  to authenticated;
grant execute on function public.cleanup_old_signals() to authenticated;
