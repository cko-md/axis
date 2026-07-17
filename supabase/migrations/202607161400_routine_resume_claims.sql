-- 202607161400_routine_resume_claims.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live schema + function bodies
-- (pg_get_functiondef, pg_indexes) on 2026-07-17.
--
-- Lease-based claim system for resuming a paused routine_run: a worker
-- claims a run with a token + expiry so two workers can't both resume the
-- same paused run, and can renew/release/complete the claim as the resumed
-- step executes. claim/complete/release/renew/repause all use `for update`
-- row locks plus explicit expected-state checks, matching the CAS pattern
-- used elsewhere in this schema (see 202607161300_task_approval_atomic.sql).

alter table public.routine_runs
  add column if not exists resume_claim_token uuid,
  add column if not exists resume_claimed_at timestamptz,
  add column if not exists resume_claim_expires_at timestamptz,
  add column if not exists resume_attempt integer not null default 0;

create unique index if not exists idx_routine_runs_resume_claim_token
  on public.routine_runs (resume_claim_token)
  where resume_claim_token is not null;

create index if not exists idx_routine_runs_resume_claim_expiry
  on public.routine_runs (resume_claim_expires_at)
  where resume_claim_token is not null;

create or replace function public.claim_routine_resume(p_user_id uuid, p_run_id uuid, p_claim_token uuid, p_lease_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_claim_expires_at timestamptz;
  v_run public.routine_runs%rowtype;
  v_approval public.approvals%rowtype;
begin
  if p_claim_token is null then
    raise exception 'claim token is required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'invalid routine resume lease' using errcode = '22023';
  end if;

  v_claim_expires_at := v_now + (p_lease_seconds * interval '1 second');

  select * into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_run.status in ('completed', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object(
      'outcome', 'terminal',
      'runId', v_run.id,
      'status', v_run.status,
      'output', v_run.output,
      'actualCostUsd', v_run.actual_cost_usd,
      'completedAt', v_run.completed_at
    );
  end if;

  if v_run.resume_claim_token is not null then
    if v_run.resume_claim_expires_at > v_now then
      if v_run.resume_claim_token = p_claim_token then
        return jsonb_build_object(
          'outcome', 'claimed',
          'runId', v_run.id,
          'status', v_run.status,
          'routineKey', v_run.routine_key,
          'routineVersion', v_run.routine_version,
          'inputSnapshot', v_run.input_snapshot,
          'stepKey', v_run.paused_step_key,
          'approvalId', v_run.approval_id,
          'idempotencyKey', v_run.idempotency_key,
          'resumeAttempt', v_run.resume_attempt,
          'claimExpiresAt', v_run.resume_claim_expires_at,
          'reused', true
        );
      end if;

      return jsonb_build_object(
        'outcome', 'busy',
        'claimExpiresAt', v_run.resume_claim_expires_at
      );
    end if;

    -- Never reactivate an expired token: a stalled worker may still hold it.
    if v_run.resume_claim_token = p_claim_token then
      return jsonb_build_object(
        'outcome', 'busy',
        'claimExpiresAt', v_run.resume_claim_expires_at,
        'expired', true
      );
    end if;

    -- Normalize an abandoned lease inside this transaction before evaluating
    -- the new claim. No observer can see the intermediate waiting state.
    update public.routine_runs
    set
      status = 'waiting_for_approval',
      resume_claim_token = null,
      resume_claimed_at = null,
      resume_claim_expires_at = null
    where id = v_run.id
    returning * into v_run;
  end if;

  if v_run.status <> 'waiting_for_approval' then
    return jsonb_build_object(
      'outcome', 'not_resumable',
      'currentStatus', v_run.status
    );
  end if;

  if nullif(trim(v_run.paused_step_key), '') is null
    or v_run.approval_id is null
    or nullif(trim(v_run.idempotency_key), '') is null
  then
    return jsonb_build_object('outcome', 'pause_metadata_missing');
  end if;

  select * into v_approval
  from public.approvals
  where id = v_run.approval_id and user_id = p_user_id
  for update;

  if not found or v_approval.status <> 'approved' then
    return jsonb_build_object(
      'outcome', 'approval_not_approved',
      'currentStatus', case when v_approval.id is null then null else v_approval.status end
    );
  end if;

  if v_approval.expires_at is not null and v_approval.expires_at <= v_now then
    update public.approvals
    set status = 'expired'
    where id = v_approval.id
      and user_id = p_user_id
      and status = 'approved'
    returning * into v_approval;

    if found and v_approval.task_id is not null then
      insert into public.agent_task_activity (task_id, user_id, kind, detail)
      values (
        v_approval.task_id,
        p_user_id,
        'approval_decision',
        jsonb_build_object(
          'approval_id', v_approval.id,
          'from', 'approved',
          'to', 'expired',
          'source', 'routine_resume_claim'
        )
      );
    end if;

    return jsonb_build_object('outcome', 'approval_expired');
  end if;

  if not public.is_approval_scope_complete(
    v_approval.user_id,
    v_approval.action_class,
    v_approval.requirement,
    v_approval.reasons,
    v_approval.proposed_action,
    v_approval.scope,
    v_approval.expires_at,
    v_approval.created_at,
    v_now
  ) then
    return jsonb_build_object('outcome', 'approval_not_actionable');
  end if;

  if v_approval.requirement = 'approval_step_up'
    and (
      v_approval.step_up_verified_at is null
      or v_approval.step_up_verified_at < v_now - interval '5 minutes'
      or v_approval.step_up_verified_at > v_now + interval '1 minute'
    )
  then
    return jsonb_build_object('outcome', 'step_up_stale');
  end if;

  update public.routine_runs
  set
    status = 'running',
    error = null,
    resume_claim_token = p_claim_token,
    resume_claimed_at = v_now,
    resume_claim_expires_at = v_claim_expires_at,
    resume_attempt = resume_attempt + 1
  where id = v_run.id
    and user_id = p_user_id
    and status = 'waiting_for_approval'
    and resume_claim_token is null
  returning * into v_run;

  if not found then
    return jsonb_build_object('outcome', 'busy');
  end if;

  return jsonb_build_object(
    'outcome', 'claimed',
    'runId', v_run.id,
    'status', v_run.status,
    'routineKey', v_run.routine_key,
    'routineVersion', v_run.routine_version,
    'inputSnapshot', v_run.input_snapshot,
    'stepKey', v_run.paused_step_key,
    'approvalId', v_run.approval_id,
    'idempotencyKey', v_run.idempotency_key,
    'resumeAttempt', v_run.resume_attempt,
    'claimExpiresAt', v_run.resume_claim_expires_at,
    'reused', false
  );
end;
$function$;

revoke all on function public.claim_routine_resume(uuid, uuid, uuid, integer) from public;
grant execute on function public.claim_routine_resume(uuid, uuid, uuid, integer) to service_role;

create or replace function public.renew_routine_resume_claim(p_user_id uuid, p_run_id uuid, p_claim_token uuid, p_lease_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
  v_approval public.approvals%rowtype;
begin
  if p_claim_token is null then
    raise exception 'claim token is required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'invalid routine resume lease' using errcode = '22023';
  end if;

  select * into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_run.status in ('completed', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'terminal', 'status', v_run.status);
  end if;

  if v_run.status <> 'running'
    or v_run.resume_claim_token is distinct from p_claim_token
    or v_run.resume_claim_expires_at is null
    or v_run.resume_claim_expires_at <= v_now
  then
    return jsonb_build_object(
      'outcome', 'claim_lost',
      'currentStatus', v_run.status
    );
  end if;

  select * into v_approval
  from public.approvals
  where id = v_run.approval_id and user_id = p_user_id
  for update;

  if not found or v_approval.status <> 'approved' then
    return jsonb_build_object(
      'outcome', 'approval_not_approved',
      'currentStatus',
      case when v_approval.id is null then null else v_approval.status end
    );
  end if;

  if v_approval.expires_at is not null and v_approval.expires_at <= v_now then
    update public.approvals
    set status = 'expired'
    where id = v_approval.id
      and user_id = p_user_id
      and status = 'approved'
    returning * into v_approval;

    if found and v_approval.task_id is not null then
      insert into public.agent_task_activity (task_id, user_id, kind, detail)
      values (
        v_approval.task_id,
        p_user_id,
        'approval_decision',
        jsonb_build_object(
          'approval_id', v_approval.id,
          'from', 'approved',
          'to', 'expired',
          'source', 'routine_resume_renewal'
        )
      );
    end if;

    return jsonb_build_object('outcome', 'approval_expired');
  end if;

  if not public.is_approval_scope_complete(
    v_approval.user_id,
    v_approval.action_class,
    v_approval.requirement,
    v_approval.reasons,
    v_approval.proposed_action,
    v_approval.scope,
    v_approval.expires_at,
    v_approval.created_at,
    v_now
  ) then
    return jsonb_build_object('outcome', 'approval_not_actionable');
  end if;

  if v_approval.requirement = 'approval_step_up'
    and (
      v_approval.step_up_verified_at is null
      or v_approval.step_up_verified_at < v_now - interval '5 minutes'
      or v_approval.step_up_verified_at > v_now + interval '1 minute'
    )
  then
    return jsonb_build_object('outcome', 'step_up_stale');
  end if;

  update public.routine_runs
  set resume_claim_expires_at =
    v_now + (p_lease_seconds * interval '1 second')
  where id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'outcome', 'renewed',
    'claimExpiresAt', v_run.resume_claim_expires_at,
    'resumeAttempt', v_run.resume_attempt
  );
end;
$function$;

revoke all on function public.renew_routine_resume_claim(uuid, uuid, uuid, integer) from public;
grant execute on function public.renew_routine_resume_claim(uuid, uuid, uuid, integer) to service_role;

create or replace function public.release_routine_resume_claim(p_user_id uuid, p_run_id uuid, p_claim_token uuid, p_error_code text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
begin
  if p_claim_token is null then
    raise exception 'claim token is required' using errcode = '22023';
  end if;
  if p_error_code is not null
    and (
      length(trim(p_error_code)) = 0
      or length(p_error_code) > 128
    )
  then
    raise exception 'invalid routine resume error code' using errcode = '22023';
  end if;

  select * into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_run.status in ('completed', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'terminal', 'status', v_run.status);
  end if;

  if v_run.status <> 'running'
    or v_run.resume_claim_token is distinct from p_claim_token
    or v_run.resume_claim_expires_at is null
    or v_run.resume_claim_expires_at <= v_now
  then
    return jsonb_build_object(
      'outcome', 'claim_lost',
      'currentStatus', v_run.status
    );
  end if;

  update public.routine_runs
  set
    status = 'waiting_for_approval',
    error = case when p_error_code is null then null else trim(p_error_code) end,
    resume_claim_token = null,
    resume_claimed_at = null,
    resume_claim_expires_at = null
  where id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'outcome', 'released',
    'status', v_run.status,
    'stepKey', v_run.paused_step_key,
    'approvalId', v_run.approval_id,
    'idempotencyKey', v_run.idempotency_key,
    'resumeAttempt', v_run.resume_attempt
  );
end;
$function$;

revoke all on function public.release_routine_resume_claim(uuid, uuid, uuid, text) from public;
grant execute on function public.release_routine_resume_claim(uuid, uuid, uuid, text) to service_role;

create or replace function public.complete_routine_resume(p_user_id uuid, p_run_id uuid, p_claim_token uuid, p_status text, p_output jsonb, p_actual_cost_usd numeric default 0)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
  v_approval public.approvals%rowtype;
begin
  if p_claim_token is null then
    raise exception 'claim token is required' using errcode = '22023';
  end if;
  if p_status not in ('completed', 'partial') then
    raise exception 'invalid routine resume completion status'
      using errcode = '22023';
  end if;
  if p_actual_cost_usd is null or p_actual_cost_usd < 0 then
    raise exception 'invalid routine resume cost' using errcode = '22023';
  end if;

  select * into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- A lost response after commit is safe to retry. Never overwrite the
  -- persisted terminal output or cost.
  if v_run.status in ('completed', 'partial') then
    return jsonb_build_object(
      'outcome', 'completed',
      'status', v_run.status,
      'output', v_run.output,
      'actualCostUsd', v_run.actual_cost_usd,
      'completedAt', v_run.completed_at,
      'approvalId', v_run.approval_id,
      'reused', true
    );
  end if;
  if v_run.status in ('failed', 'cancelled') then
    return jsonb_build_object('outcome', 'terminal', 'status', v_run.status);
  end if;

  if v_run.status <> 'running'
    or v_run.resume_claim_token is distinct from p_claim_token
    or v_run.resume_claim_expires_at is null
    or v_run.resume_claim_expires_at <= v_now
  then
    return jsonb_build_object(
      'outcome', 'claim_lost',
      'currentStatus', v_run.status
    );
  end if;

  if v_run.approval_id is null or v_run.paused_step_key is null then
    return jsonb_build_object('outcome', 'pause_metadata_missing');
  end if;

  if exists (
    select 1
    from public.routine_step_runs
    where run_id = v_run.id
      and user_id = p_user_id
      and status in ('pending', 'running')
  ) then
    return jsonb_build_object('outcome', 'steps_incomplete');
  end if;

  select * into v_approval
  from public.approvals
  where id = v_run.approval_id and user_id = p_user_id
  for update;

  if not found or v_approval.status <> 'approved' then
    return jsonb_build_object(
      'outcome', 'approval_not_approved',
      'currentStatus', case when v_approval.id is null then null else v_approval.status end
    );
  end if;

  if v_approval.expires_at is not null and v_approval.expires_at <= v_now then
    update public.approvals
    set status = 'expired'
    where id = v_approval.id
      and user_id = p_user_id
      and status = 'approved'
    returning * into v_approval;

    if found and v_approval.task_id is not null then
      insert into public.agent_task_activity (task_id, user_id, kind, detail)
      values (
        v_approval.task_id,
        p_user_id,
        'approval_decision',
        jsonb_build_object(
          'approval_id', v_approval.id,
          'from', 'approved',
          'to', 'expired',
          'source', 'routine_resume_completion'
        )
      );
    end if;

    return jsonb_build_object('outcome', 'approval_expired');
  end if;

  if not public.is_approval_scope_complete(
    v_approval.user_id,
    v_approval.action_class,
    v_approval.requirement,
    v_approval.reasons,
    v_approval.proposed_action,
    v_approval.scope,
    v_approval.expires_at,
    v_approval.created_at,
    v_now
  ) then
    return jsonb_build_object('outcome', 'approval_not_actionable');
  end if;

  if v_approval.requirement = 'approval_step_up'
    and (
      v_approval.step_up_verified_at is null
      or v_approval.step_up_verified_at < v_now - interval '5 minutes'
      or v_approval.step_up_verified_at > v_now + interval '1 minute'
    )
  then
    return jsonb_build_object('outcome', 'step_up_stale');
  end if;

  update public.approvals
  set status = 'executed'
  where id = v_approval.id
    and user_id = p_user_id
    and status = 'approved'
  returning * into v_approval;

  if not found then
    return jsonb_build_object('outcome', 'approval_not_approved');
  end if;

  if v_approval.task_id is not null then
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    values (
      v_approval.task_id,
      p_user_id,
      'approval_decision',
      jsonb_build_object(
        'approval_id', v_approval.id,
        'from', 'approved',
        'to', 'executed',
        'source', 'routine_resume_completion'
      )
    );
  end if;

  update public.routine_runs
  set
    status = p_status,
    output = p_output,
    actual_cost_usd = p_actual_cost_usd,
    error = null,
    completed_at = v_now,
    resume_claim_token = null,
    resume_claimed_at = null,
    resume_claim_expires_at = null
  where id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'outcome', 'completed',
    'status', v_run.status,
    'output', v_run.output,
    'actualCostUsd', v_run.actual_cost_usd,
    'completedAt', v_run.completed_at,
    'approvalId', v_run.approval_id,
    'reused', false
  );
end;
$function$;

revoke all on function public.complete_routine_resume(uuid, uuid, uuid, text, jsonb, numeric) from public;
grant execute on function public.complete_routine_resume(uuid, uuid, uuid, text, jsonb, numeric) to service_role;

create or replace function public.repause_routine_resume(p_user_id uuid, p_run_id uuid, p_claim_token uuid, p_step_key text, p_approval_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
  v_old_approval public.approvals%rowtype;
  v_new_approval public.approvals%rowtype;
begin
  if p_claim_token is null or p_approval_id is null then
    raise exception 'claim token and approval are required' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_step_key, ''))) = 0
    or length(p_step_key) > 256
    or length(trim(coalesce(p_idempotency_key, ''))) = 0
    or length(p_idempotency_key) > 512
  then
    raise exception 'invalid routine pause metadata' using errcode = '22023';
  end if;

  select * into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_run.status in ('completed', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'terminal', 'status', v_run.status);
  end if;

  if v_run.status <> 'running'
    or v_run.resume_claim_token is distinct from p_claim_token
    or v_run.resume_claim_expires_at is null
    or v_run.resume_claim_expires_at <= v_now
  then
    return jsonb_build_object(
      'outcome', 'claim_lost',
      'currentStatus', v_run.status
    );
  end if;

  if v_run.approval_id is null or v_run.paused_step_key is null then
    return jsonb_build_object('outcome', 'pause_metadata_missing');
  end if;
  if v_run.approval_id = p_approval_id then
    raise exception 'replacement approval must be distinct' using errcode = '22023';
  end if;

  -- Lock both approvals in stable UUID order. The run lock serializes calls for
  -- this run; stable ordering also avoids cross-run approval lock inversions.
  perform id
  from public.approvals
  where user_id = p_user_id
    and id in (v_run.approval_id, p_approval_id)
  order by id
  for update;

  select * into v_old_approval
  from public.approvals
  where id = v_run.approval_id and user_id = p_user_id;

  select * into v_new_approval
  from public.approvals
  where id = p_approval_id and user_id = p_user_id;

  if v_old_approval.id is null or v_old_approval.status <> 'approved' then
    return jsonb_build_object(
      'outcome', 'approval_not_approved',
      'currentStatus',
      case when v_old_approval.id is null then null else v_old_approval.status end
    );
  end if;
  if v_new_approval.id is null then
    return jsonb_build_object('outcome', 'replacement_approval_not_found');
  end if;
  if v_new_approval.status <> 'pending' then
    return jsonb_build_object(
      'outcome', 'replacement_approval_not_pending',
      'currentStatus', v_new_approval.status
    );
  end if;

  update public.approvals
  set status = 'expired'
  where id = v_old_approval.id
    and user_id = p_user_id
    and status = 'approved'
  returning * into v_old_approval;

  if not found then
    return jsonb_build_object('outcome', 'approval_not_approved');
  end if;

  if v_old_approval.task_id is not null then
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    values (
      v_old_approval.task_id,
      p_user_id,
      'approval_decision',
      jsonb_build_object(
        'approval_id', v_old_approval.id,
        'from', 'approved',
        'to', 'expired',
        'source', 'routine_resume_repause',
        'superseded_by_approval_id', v_new_approval.id
      )
    );
  end if;

  update public.routine_runs
  set
    status = 'waiting_for_approval',
    paused_step_key = trim(p_step_key),
    approval_id = v_new_approval.id,
    idempotency_key = trim(p_idempotency_key),
    error = null,
    resume_claim_token = null,
    resume_claimed_at = null,
    resume_claim_expires_at = null
  where id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'outcome', 'repaused',
    'status', v_run.status,
    'stepKey', v_run.paused_step_key,
    'approvalId', v_run.approval_id,
    'idempotencyKey', v_run.idempotency_key,
    'resumeAttempt', v_run.resume_attempt
  );
end;
$function$;

revoke all on function public.repause_routine_resume(uuid, uuid, uuid, text, uuid, text) from public;
grant execute on function public.repause_routine_resume(uuid, uuid, uuid, text, uuid, text) to service_role;
