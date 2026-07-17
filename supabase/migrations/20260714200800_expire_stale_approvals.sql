-- 202607140300_expire_stale_approvals.sql
-- Hygiene sweeper for the approval queue: mark pending approvals whose
-- expires_at has passed as 'expired' so the queue reflects reality without a
-- user action. SECURITY DEFINER (mirrors mark_overdue_tasks / cleanup_*) so a
-- cron request — which has no user session — can sweep across all users;
-- set search_path pins schema resolution. Applied + verified on the live project.
--
-- Note: this is HYGIENE, not the security gate. isActionable already refuses to
-- execute an expired approval regardless of its stored status.
create or replace function public.expire_stale_approvals()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  update public.approvals
  set status = 'expired', decided_at = now()
  where status = 'pending'
    and expires_at is not null
    and expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.expire_stale_approvals() to authenticated;
