-- 20260716002837_lock_expire_stale_approvals.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from the live function body
-- (pg_get_functiondef) on 2026-07-17.
--
-- Supersedes the function originally created in
-- 20260714200800_202607140300_expire_stale_approvals.sql (whose original
-- body could not be recovered — see that file). This version expires
-- pending approvals past expires_at in a single UPDATE ... RETURNING CTE
-- (implicitly row-locking, no separate SELECT-then-UPDATE race window) and
-- logs each transition to agent_task_activity.

create or replace function public.expire_stale_approvals()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_affected integer;
begin
  with expired as (
    update public.approvals
    set status = 'expired', decided_at = now()
    where status = 'pending'
      and expires_at is not null
      and expires_at < now()
    returning id, user_id, task_id
  ),
  logged as (
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    select
      task_id,
      user_id,
      'approval_decision',
      jsonb_build_object(
        'approval_id', id,
        'from', 'pending',
        'to', 'expired',
        'source', 'maintenance'
      )
    from expired
    where task_id is not null
    returning 1
  )
  select count(*)::integer into v_affected from expired;

  return v_affected;
end;
$function$;

revoke all on function public.expire_stale_approvals() from public;
grant execute on function public.expire_stale_approvals() to service_role;
