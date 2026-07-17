-- 202607161300_task_approval_atomic.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live function bodies
-- (pg_get_functiondef) on 2026-07-17.
--
-- Compare-and-swap transition functions for agent_tasks and approvals:
-- the application is the source of truth for what transitions are legal,
-- but these functions re-check the same state machine at the database layer
-- (defense in depth) and use `where status = p_expected_status` to make the
-- transition atomic under concurrent callers instead of read-then-write.

create or replace function public.cas_agent_task_transition(p_user_id uuid, p_task_id uuid, p_expected_status text, p_next_status text, p_completed_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_task public.agent_tasks%rowtype;
  v_current_status text;
begin
  -- Defense in depth for trusted server callers. TypeScript remains the
  -- user-facing policy kernel, while the database refuses impossible writes
  -- if a future server path calls this RPC incorrectly.
  if not (
    case p_expected_status
      when 'queued' then p_next_status in (
        'gathering_data', 'researching', 'calculating', 'executing',
        'blocked', 'cancelled'
      )
      when 'gathering_data' then p_next_status in (
        'researching', 'calculating', 'executing',
        'waiting_for_data', 'waiting_for_user', 'waiting_for_approval',
        'blocked', 'completed', 'failed', 'cancelled'
      )
      when 'researching' then p_next_status in (
        'gathering_data', 'calculating', 'executing',
        'waiting_for_data', 'waiting_for_user', 'waiting_for_approval',
        'blocked', 'completed', 'failed', 'cancelled'
      )
      when 'calculating' then p_next_status in (
        'gathering_data', 'researching', 'executing',
        'waiting_for_data', 'waiting_for_user', 'waiting_for_approval',
        'blocked', 'completed', 'failed', 'cancelled'
      )
      when 'executing' then p_next_status in (
        'calculating', 'waiting_for_data', 'waiting_for_user',
        'waiting_for_approval', 'blocked', 'completed', 'failed', 'cancelled'
      )
      when 'waiting_for_data' then p_next_status in (
        'gathering_data', 'researching', 'calculating', 'executing',
        'blocked', 'failed', 'cancelled'
      )
      when 'waiting_for_user' then p_next_status in (
        'gathering_data', 'researching', 'calculating', 'executing',
        'blocked', 'failed', 'cancelled'
      )
      when 'waiting_for_approval' then p_next_status in (
        'gathering_data', 'researching', 'calculating', 'executing',
        'blocked', 'failed', 'cancelled'
      )
      when 'blocked' then p_next_status in (
        'gathering_data', 'researching', 'calculating', 'executing',
        'failed', 'cancelled'
      )
      else false
    end
  ) then
    raise exception 'invalid task transition' using errcode = '22023';
  end if;

  update public.agent_tasks
  set
    status = p_next_status,
    updated_at = now(),
    completed_at = case
      when p_next_status in ('completed', 'failed', 'cancelled')
        then coalesce(p_completed_at, now())
      else null
    end
  where id = p_task_id
    and user_id = p_user_id
    and status = p_expected_status
  returning * into v_task;

  if found then
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    values (
      v_task.id,
      p_user_id,
      'status_change',
      jsonb_build_object('from', p_expected_status, 'to', p_next_status)
    );

    return jsonb_build_object('outcome', 'updated', 'task', to_jsonb(v_task));
  end if;

  select status into v_current_status
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object(
    'outcome', 'conflict',
    'currentStatus', v_current_status
  );
end;
$function$;

revoke all on function public.cas_agent_task_transition(uuid, uuid, text, text, timestamptz) from public;
grant execute on function public.cas_agent_task_transition(uuid, uuid, text, text, timestamptz) to service_role;

create or replace function public.cas_approval_transition(p_user_id uuid, p_approval_id uuid, p_expected_status text, p_next_status text, p_decided_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_approval public.approvals%rowtype;
  v_current_status text;
begin
  if not (
    (p_expected_status = 'pending' and p_next_status in ('approved', 'denied', 'expired'))
    or (p_expected_status = 'approved' and p_next_status = 'expired')
  ) then
    raise exception 'invalid approval transition' using errcode = '22023';
  end if;

  update public.approvals
  set
    status = p_next_status,
    decided_at = coalesce(p_decided_at, decided_at)
  where id = p_approval_id
    and user_id = p_user_id
    and status = p_expected_status
  returning * into v_approval;

  if found then
    if v_approval.task_id is not null then
      insert into public.agent_task_activity (task_id, user_id, kind, detail)
      values (
        v_approval.task_id,
        p_user_id,
        'approval_decision',
        jsonb_build_object(
          'approval_id', v_approval.id,
          'from', p_expected_status,
          'to', p_next_status
        )
      );
    end if;

    return jsonb_build_object(
      'outcome', 'updated',
      'approval', to_jsonb(v_approval)
    );
  end if;

  select status into v_current_status
  from public.approvals
  where id = p_approval_id and user_id = p_user_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object(
    'outcome', 'conflict',
    'currentStatus', v_current_status
  );
end;
$function$;

revoke all on function public.cas_approval_transition(uuid, uuid, text, text, timestamptz) from public;
grant execute on function public.cas_approval_transition(uuid, uuid, text, text, timestamptz) to service_role;
