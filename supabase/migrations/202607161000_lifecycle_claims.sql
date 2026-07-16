-- Wave 15.1: atomic task transitions and fenced approval-resume claims.

begin;

-- ── Agent-task lifecycle ──────────────────────────────────────────────────

drop function if exists public.create_agent_task(text, jsonb, uuid, text, numeric);
drop function if exists public.create_agent_task(uuid, text, jsonb, uuid, text, numeric);

create or replace function public.create_agent_task(
  p_user_id uuid,
  p_objective text,
  p_context jsonb default '{}'::jsonb,
  p_source_routine_id uuid default null,
  p_source_skill text default null,
  p_estimated_cost_usd numeric default null,
  p_source_claim_token uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_activity public.agent_task_activity%rowtype;
  v_objective text := btrim(coalesce(p_objective, ''));
  v_context jsonb := coalesce(p_context, '{}'::jsonb);
  v_source_run record;
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = '22023';
  end if;
  if v_objective = '' or char_length(v_objective) > 2000 then
    raise exception 'invalid task objective' using errcode = '22023';
  end if;
  if jsonb_typeof(v_context) <> 'object' then
    raise exception 'task context must be an object' using errcode = '22023';
  end if;
  if p_estimated_cost_usd is not null
     and (p_estimated_cost_usd < 0 or p_estimated_cost_usd = 'NaN'::numeric) then
    raise exception 'invalid estimated cost' using errcode = '22023';
  end if;
  if p_source_routine_id is null and p_source_claim_token is not null then
    raise exception 'source claim requires a routine run' using errcode = '22023';
  end if;
  if p_source_routine_id is not null then
    select
      status,
      routine_key,
      paused_step_key,
      approval_id,
      error,
      resume_claim_token,
      resume_claim_expires_at
    into v_source_run
    from public.routine_runs
    where id = p_source_routine_id
      and user_id = p_user_id
    for update;

    if not found then
      raise exception 'source routine run not found' using errcode = '22023';
    end if;
    if nullif(btrim(p_source_skill), '') is distinct from v_source_run.routine_key then
      raise exception 'source routine skill mismatch' using errcode = '22023';
    end if;
    if p_source_claim_token is null then
      if v_source_run.status <> 'running'
         or v_source_run.paused_step_key is not null
         or v_source_run.approval_id is not null
         or v_source_run.error = 'STALE_RESUME_CLAIM_REQUIRES_REVIEW'
         or v_source_run.resume_claim_token is not null
         or v_source_run.resume_claim_expires_at is not null then
        raise exception 'source routine claim required' using errcode = '55000';
      end if;
    elsif v_source_run.status <> 'running'
       or v_source_run.resume_claim_token is distinct from p_source_claim_token
       or v_source_run.resume_claim_expires_at is null
       or v_source_run.resume_claim_expires_at <= statement_timestamp() then
      raise exception 'source routine claim lost' using errcode = '55000';
    end if;
  end if;

  insert into public.agent_tasks (
    user_id,
    objective,
    status,
    context,
    source_routine_id,
    source_skill,
    estimated_cost_usd
  )
  values (
    p_user_id,
    v_objective,
    'queued',
    v_context,
    p_source_routine_id,
    nullif(btrim(p_source_skill), ''),
    p_estimated_cost_usd
  )
  returning * into v_task;

  insert into public.agent_task_activity (task_id, user_id, kind, detail)
  values (
    v_task.id,
    p_user_id,
    'status_change',
    jsonb_build_object(
      'from', null,
      'to', 'queued'
    ) || case
      when nullif(btrim(p_source_skill), '') is null then '{}'::jsonb
      else jsonb_build_object('by', nullif(btrim(p_source_skill), ''))
    end
  )
  returning * into v_activity;

  return jsonb_build_object(
    'task', jsonb_build_object(
      'id', v_task.id,
      'objective', v_task.objective,
      'status', v_task.status,
      'context', v_task.context,
      'source_routine_id', v_task.source_routine_id,
      'source_skill', v_task.source_skill,
      'estimated_cost_usd', v_task.estimated_cost_usd,
      'actual_cost_usd', v_task.actual_cost_usd,
      'created_at', v_task.created_at,
      'updated_at', v_task.updated_at,
      'completed_at', v_task.completed_at
    ),
    'activity', jsonb_build_object(
      'id', v_activity.id,
      'kind', v_activity.kind,
      'detail', v_activity.detail,
      'created_at', v_activity.created_at
    )
  );
end;
$$;

revoke all on function public.create_agent_task(uuid, text, jsonb, uuid, text, numeric, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_agent_task(uuid, text, jsonb, uuid, text, numeric, uuid)
  to service_role;

drop function if exists public.transition_agent_task(uuid, text, text, timestamptz);

create or replace function public.transition_agent_task(
  p_task_id uuid,
  p_expected_status text,
  p_next_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.agent_tasks%rowtype;
  v_allowed boolean;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_allowed := case p_expected_status
    when 'queued' then p_next_status = any(array['gathering_data','researching','calculating','executing','blocked','cancelled'])
    when 'gathering_data' then p_next_status = any(array['researching','calculating','executing','waiting_for_data','waiting_for_user','waiting_for_approval','blocked','completed','failed','cancelled'])
    when 'researching' then p_next_status = any(array['gathering_data','calculating','executing','waiting_for_data','waiting_for_user','waiting_for_approval','blocked','completed','failed','cancelled'])
    when 'calculating' then p_next_status = any(array['gathering_data','researching','executing','waiting_for_data','waiting_for_user','waiting_for_approval','blocked','completed','failed','cancelled'])
    when 'executing' then p_next_status = any(array['calculating','waiting_for_data','waiting_for_user','waiting_for_approval','blocked','completed','failed','cancelled'])
    when 'waiting_for_data' then p_next_status = any(array['gathering_data','researching','calculating','executing','blocked','failed','cancelled'])
    when 'waiting_for_user' then p_next_status = any(array['gathering_data','researching','calculating','executing','blocked','failed','cancelled'])
    when 'waiting_for_approval' then p_next_status = any(array['executing','gathering_data','researching','calculating','blocked','failed','cancelled'])
    when 'blocked' then p_next_status = any(array['gathering_data','researching','calculating','executing','failed','cancelled'])
    else false
  end;
  if not v_allowed then
    raise exception 'illegal agent-task transition' using errcode = '22023';
  end if;

  update public.agent_tasks
  set
    status = p_next_status,
    updated_at = statement_timestamp(),
    completed_at = case
      when p_next_status = any(array['completed','failed','cancelled']) then statement_timestamp()
      else completed_at
    end
  where id = p_task_id
    and user_id = v_user_id
    and status = p_expected_status
  returning * into v_task;

  if not found then return null; end if;

  insert into public.agent_task_activity (task_id, user_id, kind, detail)
  values (
    v_task.id,
    v_task.user_id,
    'status_change',
    jsonb_build_object('from', p_expected_status, 'to', p_next_status)
  );

  return jsonb_build_object(
    'id', v_task.id,
    'objective', v_task.objective,
    'status', v_task.status,
    'context', v_task.context,
    'created_at', v_task.created_at,
    'updated_at', v_task.updated_at,
    'completed_at', v_task.completed_at
  );
end;
$$;

revoke all on function public.transition_agent_task(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transition_agent_task(uuid, text, text) to authenticated;

-- The owner can read task state, but every mutation goes through a trusted,
-- atomic RPC. Drop the legacy owner-mutation policies as defense in depth:
-- RLS policies can otherwise become authority again after a future broad grant.
revoke all privileges on table public.agent_tasks
  from anon, authenticated;
revoke all privileges on table public.agent_task_activity
  from anon, authenticated;
grant select on table public.agent_tasks, public.agent_task_activity
  to authenticated;

drop policy if exists "agent_tasks_insert_own" on public.agent_tasks;
drop policy if exists "agent_tasks_update_own" on public.agent_tasks;
drop policy if exists "agent_tasks_delete_own" on public.agent_tasks;
drop policy if exists "agent_task_activity_insert_own" on public.agent_task_activity;

-- ── Approval-resume fencing ───────────────────────────────────────────────

alter table public.approvals
  drop constraint if exists approvals_status_check;
alter table public.approvals
  add constraint approvals_status_check
  check (status in ('pending', 'approved', 'executing', 'denied', 'expired', 'executed'));

alter table public.approvals
  add column if not exists execution_claim_token uuid,
  add column if not exists execution_claimed_at timestamptz,
  add column if not exists execution_run_id uuid;

alter table public.routine_runs
  add column if not exists resume_claim_token uuid,
  add column if not exists resume_claimed_at timestamptz,
  add column if not exists resume_claim_expires_at timestamptz,
  add column if not exists resume_attempt integer not null default 0;

alter table public.routine_runs
  drop constraint if exists routine_runs_resume_attempt_check,
  drop constraint if exists routine_runs_resume_claim_fields_check,
  drop constraint if exists routine_runs_resume_claim_status_check,
  drop constraint if exists routine_runs_resume_claim_window_check;
alter table public.routine_runs
  add constraint routine_runs_resume_attempt_check
    check (resume_attempt >= 0),
  add constraint routine_runs_resume_claim_fields_check
    check (
      (
        resume_claim_token is null
        and resume_claimed_at is null
        and resume_claim_expires_at is null
      )
      or
      (
        resume_claim_token is not null
        and resume_claimed_at is not null
        and resume_claim_expires_at is not null
      )
    ),
  add constraint routine_runs_resume_claim_status_check
    check (resume_claim_token is null or status = 'running'),
  add constraint routine_runs_resume_claim_window_check
    check (
      resume_claim_token is null
      or resume_claim_expires_at > resume_claimed_at
    );

-- All pre-migration high-risk step-up stamps were written while owner sessions
-- could mutate approval authority, so they are not trustworthy. Run this
-- remediation only on the first application (the durable constraint is the
-- marker); later idempotent replays must preserve legitimate active approvals.
do $$
declare
  v_active_count bigint;
  v_stamped_count bigint;
  v_already_hardened boolean;
begin
  select exists (
    select 1
    from pg_constraint
    where conrelid = 'public.approvals'::regclass
      and conname = 'approvals_high_risk_step_up_check'
      and contype = 'c'
  ) into v_already_hardened;

  if v_already_hardened then
    raise notice 'wave 15.1 high-risk approval remediation already applied; preserving active approvals';
    return;
  end if;

  select count(*) into v_active_count
  from public.approvals
  where action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
    and status in ('pending', 'approved', 'executing');

  select count(*) into v_stamped_count
  from public.approvals
  where action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
    and step_up_verified_at is not null;

  raise notice
    'wave 15.1 high-risk approval preflight: active=%, unverifiable_stamps=%',
    v_active_count,
    v_stamped_count;

  update public.routine_runs as runs
  set
    status = 'blocked',
    error = 'LEGACY_HIGH_RISK_APPROVAL_INVALIDATED',
    resume_claim_token = null,
    resume_claimed_at = null,
    resume_claim_expires_at = null,
    completed_at = null
  from public.approvals as approvals
  where runs.approval_id = approvals.id
    and approvals.action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
    and approvals.status in ('pending', 'approved', 'executing')
    and runs.status in ('waiting_for_approval', 'running');

  update public.approvals
  set
    requirement = 'approval_step_up',
    scope = 'one_time',
    step_up_verified_at = null,
    decided_at = case
      when status in ('pending', 'approved', 'executing')
        then coalesce(decided_at, statement_timestamp())
      else decided_at
    end,
    status = case
      when status in ('pending', 'approved', 'executing') then 'expired'
      else status
    end,
    execution_claim_token = case
      when status in ('pending', 'approved', 'executing') then null
      else execution_claim_token
    end,
    execution_claimed_at = case
      when status in ('pending', 'approved', 'executing') then null
      else execution_claimed_at
    end,
    execution_run_id = case
      when status in ('pending', 'approved', 'executing') then null
      else execution_run_id
    end
  where action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN');
end $$;

alter table public.approvals
  drop constraint if exists approvals_high_risk_step_up_check;
alter table public.approvals
  add constraint approvals_high_risk_step_up_check
  check (
    action_class not in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
    or (requirement = 'approval_step_up' and scope = 'one_time')
  );

-- Durable run and step snapshots are trusted server audit records. Browser
-- clients retain owner-scoped SELECT through RLS, but cannot forge execution
-- inputs, outputs, statuses, or approval links.
revoke all privileges on table public.routine_runs, public.routine_step_runs
  from anon, authenticated;
grant select on table public.routine_runs, public.routine_step_runs
  to authenticated;
drop policy if exists "routine_runs_insert_own" on public.routine_runs;
drop policy if exists "routine_runs_update_own" on public.routine_runs;
drop policy if exists "routine_step_runs_insert_own" on public.routine_step_runs;
drop policy if exists "routine_step_runs_update_own" on public.routine_step_runs;

create unique index if not exists idx_routine_runs_id_user
  on public.routine_runs (id, user_id);

do $$
begin
  if exists (
    select 1
    from public.routine_runs
    where approval_id is not null
    group by approval_id
    having count(*) > 1
  ) then
    raise exception 'duplicate routine approval links must be resolved before lifecycle claims';
  end if;
end $$;

create unique index if not exists idx_routine_runs_approval_once
  on public.routine_runs (approval_id)
  where approval_id is not null;

drop index if exists public.idx_approvals_execution_run_once;
create index if not exists idx_approvals_execution_run
  on public.approvals (execution_run_id)
  where execution_run_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'approvals_execution_run_owner_fkey'
  ) then
    alter table public.approvals
      add constraint approvals_execution_run_owner_fkey
      foreign key (execution_run_id, user_id)
      references public.routine_runs (id, user_id);
  end if;
end $$;

-- Browser clients cannot create or mutate approval authority. Trusted server
-- routes use the service role after authenticating and owner-scoping.
revoke all privileges on table public.approvals from anon, authenticated;
grant select on table public.approvals to authenticated;
drop policy if exists "approvals_insert_own" on public.approvals;
drop policy if exists "approvals_update_own" on public.approvals;

-- Credential rows, authenticator counters, and pending ceremonies are
-- server-only authority. Verified server routes authenticate and owner-scope
-- every operation before using the service role.
drop policy if exists "Users manage own passkeys" on public.user_passkeys;
drop policy if exists "user_passkeys_select_own" on public.user_passkeys;
drop policy if exists "Users read own passkeys" on public.user_passkeys;
do $$
declare
  v_policy record;
begin
  for v_policy in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('user_passkeys', 'webauthn_challenges')
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      v_policy.policyname,
      v_policy.tablename
    );
  end loop;
end;
$$;
revoke all privileges on table public.user_passkeys from anon, authenticated;
-- The replacement passkey flow never persists Supabase sessions in credential
-- rows. Retain the legacy column for compatibility, but erase stored values.
update public.user_passkeys
set refresh_token_enc = null
where refresh_token_enc is not null;

-- Pending ceremonies are server-only authority and must never regain TRUNCATE
-- or DML through broad bootstrap grants.
drop policy if exists "service_role_only" on public.webauthn_challenges;
revoke all privileges on table public.webauthn_challenges
  from anon, authenticated;
revoke all on function public.cleanup_expired_challenges()
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_expired_challenges()
  to service_role;

drop function if exists public.execute_approval(uuid, uuid);

create or replace function public.execute_approval(
  p_user_id uuid,
  p_approval_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_approval public.approvals%rowtype;
  v_run_id uuid;
begin
  select *
  into v_approval
  from public.approvals
  where id = p_approval_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_approval.status = 'executing' then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_IN_FLIGHT');
  end if;
  if v_approval.status <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'STALE_APPROVAL');
  end if;
  if v_approval.action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
     and (
       v_approval.requirement <> 'approval_step_up'
       or v_approval.scope <> 'one_time'
     ) then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_POLICY_MISMATCH');
  end if;
  if v_approval.expires_at is not null
     and v_approval.expires_at <= statement_timestamp() then
    update public.approvals
    set status = 'expired', decided_at = coalesce(decided_at, statement_timestamp())
    where id = p_approval_id and user_id = p_user_id and status = 'approved';
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_EXPIRED');
  end if;
  if v_approval.requirement = 'approval_step_up'
     and v_approval.step_up_verified_at is null then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_STEP_UP_REQUIRED');
  end if;
  if v_approval.requirement = 'approval_step_up'
     and (
       v_approval.step_up_verified_at < statement_timestamp() - interval '5 minutes'
       or v_approval.step_up_verified_at > statement_timestamp() + interval '1 minute'
     ) then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_STEP_UP_STALE');
  end if;
  if v_approval.execution_claim_token is not null
     or v_approval.execution_run_id is not null then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_IN_FLIGHT');
  end if;

  select id
  into v_run_id
  from public.routine_runs
  where user_id = p_user_id
    and approval_id = p_approval_id
    and status in ('waiting_for_approval', 'running')
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'ok', false,
      'code', 'ROUTINE_RESUME_REQUIRED',
      'runId', v_run_id
    );
  end if;

  update public.approvals
  set status = 'executed'
  where id = p_approval_id and user_id = p_user_id and status = 'approved'
  returning * into v_approval;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'STALE_APPROVAL');
  end if;

  return jsonb_build_object(
    'ok', true,
    'approval', jsonb_build_object(
      'id', v_approval.id,
      'task_id', v_approval.task_id,
      'action_class', v_approval.action_class,
      'requirement', v_approval.requirement,
      'reasons', v_approval.reasons,
      'proposed_action', v_approval.proposed_action,
      'status', v_approval.status,
      'step_up_verified_at', v_approval.step_up_verified_at,
      'decided_at', v_approval.decided_at,
      'expires_at', v_approval.expires_at,
      'scope', v_approval.scope,
      'created_at', v_approval.created_at
    )
  );
end;
$$;

revoke all on function public.execute_approval(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.execute_approval(uuid, uuid)
  to service_role;

drop function if exists public.claim_routine_approval_resume(uuid, uuid, uuid);

create or replace function public.claim_routine_approval_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run record;
  v_approval record;
begin
  if p_claim_token is null then
    raise exception 'claim token required' using errcode = '22023';
  end if;

  select
    status,
    approval_id,
    routine_key,
    routine_version,
    resume_claim_token
  into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'RUN_NOT_FOUND'); end if;
  if v_run.status <> 'waiting_for_approval' or v_run.approval_id <> p_approval_id or v_run.resume_claim_token is not null then
    return jsonb_build_object('ok', false, 'code', 'RUN_ALREADY_CLAIMED');
  end if;

  select
    status,
    action_class,
    requirement,
    scope,
    expires_at,
    step_up_verified_at,
    proposed_action,
    execution_claim_token,
    execution_run_id
  into v_approval
  from public.approvals
  where id = p_approval_id and user_id = p_user_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'APPROVAL_NOT_FOUND'); end if;
  if v_approval.status <> 'approved'
     or v_approval.execution_claim_token is not null
     or v_approval.execution_run_id is not null then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_ALREADY_CLAIMED');
  end if;
  if v_approval.action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
     and (
       v_approval.requirement <> 'approval_step_up'
       or v_approval.scope <> 'one_time'
     ) then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_POLICY_MISMATCH');
  end if;
  if v_approval.expires_at is not null
     and v_approval.expires_at <= statement_timestamp() then
    update public.approvals
    set status = 'expired'
    where id = p_approval_id and user_id = p_user_id and status = 'approved';
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_EXPIRED');
  end if;
  if v_approval.requirement = 'approval_step_up'
     and (
       v_approval.step_up_verified_at is null
       or v_approval.step_up_verified_at < statement_timestamp() - interval '5 minutes'
       or v_approval.step_up_verified_at > statement_timestamp() + interval '1 minute'
     ) then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_STEP_UP_REQUIRED');
  end if;
  if v_approval.proposed_action->'actor'->>'kind' is distinct from 'routine'
     or v_approval.proposed_action->'actor'->>'id' is distinct from v_run.routine_key
     or v_approval.proposed_action->'actor'->>'routineVersion' is distinct from v_run.routine_version::text
     or v_approval.proposed_action->'target'->>'entityType' is distinct from 'routine_run'
     or v_approval.proposed_action->'target'->>'entityId' is distinct from p_run_id::text then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_SCOPE_MISMATCH');
  end if;

  update public.routine_runs
  set status = 'running', resume_claim_token = p_claim_token,
      resume_claimed_at = statement_timestamp(),
      resume_claim_expires_at = statement_timestamp() + interval '10 minutes',
      resume_attempt = resume_attempt + 1,
      error = null
  where id = p_run_id and user_id = p_user_id;

  update public.approvals
  set status = 'executing', execution_claim_token = p_claim_token,
      execution_claimed_at = statement_timestamp(), execution_run_id = p_run_id
  where id = p_approval_id and user_id = p_user_id;

  return jsonb_build_object('ok', true, 'claimToken', p_claim_token);
end;
$$;

create or replace function public.renew_routine_approval_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.routine_runs
  where id = p_run_id and user_id = p_user_id
    and approval_id = p_approval_id
    and status = 'running'
    and resume_claim_token = p_claim_token
    and resume_claim_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  perform 1 from public.approvals
  where id = p_approval_id and user_id = p_user_id
    and status = 'executing'
    and execution_claim_token = p_claim_token
    and execution_run_id = p_run_id
  for update;
  if not found then return false; end if;

  update public.routine_runs
  set resume_claim_expires_at = statement_timestamp() + interval '10 minutes'
  where id = p_run_id and user_id = p_user_id
    and resume_claim_token = p_claim_token;

  update public.approvals
  set execution_claimed_at = statement_timestamp()
  where id = p_approval_id and user_id = p_user_id
    and execution_claim_token = p_claim_token;

  return true;
end;
$$;

create or replace function public.start_routine_step_under_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid,
  p_step_key text,
  p_ordinal integer,
  p_input_snapshot jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_step public.routine_step_runs%rowtype;
begin
  if p_ordinal < 1 or btrim(coalesce(p_step_key, '')) = '' then
    raise exception 'invalid routine step' using errcode = '22023';
  end if;
  if not public.renew_routine_approval_resume(
    p_user_id,
    p_run_id,
    p_approval_id,
    p_claim_token
  ) then
    return null;
  end if;

  insert into public.routine_step_runs (
    run_id,
    user_id,
    step_key,
    ordinal,
    status,
    input_snapshot,
    started_at
  )
  values (
    p_run_id,
    p_user_id,
    btrim(p_step_key),
    p_ordinal,
    'running',
    coalesce(p_input_snapshot, '{}'::jsonb),
    statement_timestamp()
  )
  returning * into v_step;

  return jsonb_build_object('id', v_step.id, 'ordinal', v_step.ordinal);
end;
$$;

create or replace function public.complete_routine_step_under_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid,
  p_step_run_id uuid,
  p_output_snapshot jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.renew_routine_approval_resume(
    p_user_id,
    p_run_id,
    p_approval_id,
    p_claim_token
  ) then
    return false;
  end if;

  update public.routine_step_runs
  set
    status = 'succeeded',
    output_snapshot = p_output_snapshot,
    error = null,
    completed_at = statement_timestamp()
  where id = p_step_run_id
    and run_id = p_run_id
    and user_id = p_user_id
    and status = 'running';

  return found;
end;
$$;

create or replace function public.fail_routine_step_under_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid,
  p_step_run_id uuid,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.renew_routine_approval_resume(
    p_user_id,
    p_run_id,
    p_approval_id,
    p_claim_token
  ) then
    return false;
  end if;

  update public.routine_step_runs
  set
    status = 'failed',
    error = left(coalesce(p_error, 'ROUTINE_STEP_FAILED'), 160),
    completed_at = statement_timestamp()
  where id = p_step_run_id
    and run_id = p_run_id
    and user_id = p_user_id
    and status = 'running';

  return found;
end;
$$;

create or replace function public.finalize_routine_approval_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid,
  p_status text,
  p_output jsonb,
  p_actual_cost_usd numeric
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (p_status = any(array['completed','partial'])) then
    raise exception 'invalid terminal run status' using errcode = '22023';
  end if;

  perform 1 from public.routine_runs
  where id = p_run_id and user_id = p_user_id
    and status = 'running' and resume_claim_token = p_claim_token
    and resume_claim_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  perform 1 from public.approvals
  where id = p_approval_id and user_id = p_user_id
    and status = 'executing' and execution_claim_token = p_claim_token
    and execution_run_id = p_run_id
  for update;
  if not found then return false; end if;

  update public.routine_runs
  set status = p_status, output = p_output,
      actual_cost_usd = p_actual_cost_usd,
      paused_step_key = null, approval_id = null, idempotency_key = null,
      resume_claim_token = null, resume_claimed_at = null,
      resume_claim_expires_at = null,
      completed_at = statement_timestamp(), error = null
  where id = p_run_id and user_id = p_user_id;

  update public.approvals
  set status = 'executed', execution_claim_token = null
  where id = p_approval_id and user_id = p_user_id;

  return true;
end;
$$;

create or replace function public.release_routine_approval_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid,
  p_claim_token uuid,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.routine_runs
  where id = p_run_id and user_id = p_user_id
    and status in ('running','blocked') and resume_claim_token = p_claim_token
    and resume_claim_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  perform 1 from public.approvals
  where id = p_approval_id and user_id = p_user_id
    and status = 'executing' and execution_claim_token = p_claim_token
    and execution_run_id = p_run_id
  for update;
  if not found then return false; end if;

  update public.routine_runs
  set status = 'waiting_for_approval', error = left(p_error, 160),
      resume_claim_token = null, resume_claimed_at = null,
      resume_claim_expires_at = null,
      completed_at = null
  where id = p_run_id and user_id = p_user_id;

  update public.approvals
  set status = 'approved', execution_claim_token = null,
      execution_claimed_at = null, execution_run_id = null
  where id = p_approval_id and user_id = p_user_id;

  return true;
end;
$$;

create or replace function public.repause_routine_approval_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_old_approval_id uuid,
  p_claim_token uuid,
  p_new_approval_id uuid,
  p_paused_step_key text,
  p_idempotency_key text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.routine_runs
  where id = p_run_id and user_id = p_user_id
    and status = 'running' and resume_claim_token = p_claim_token
    and resume_claim_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  perform 1 from public.approvals
  where id = p_old_approval_id and user_id = p_user_id
    and status = 'executing' and execution_claim_token = p_claim_token
    and execution_run_id = p_run_id
  for update;
  if not found then return false; end if;

  if p_new_approval_id = p_old_approval_id then return false; end if;

  perform 1 from public.approvals
  where id = p_new_approval_id and user_id = p_user_id
    and status in ('pending','approved')
    and execution_claim_token is null and execution_run_id is null
  for update;
  if not found then return false; end if;

  update public.routine_runs
  set status = 'waiting_for_approval', paused_step_key = p_paused_step_key,
      approval_id = p_new_approval_id, idempotency_key = p_idempotency_key,
      resume_claim_token = null, resume_claimed_at = null,
      resume_claim_expires_at = null, error = null
  where id = p_run_id and user_id = p_user_id;

  update public.approvals
  set status = 'executed', execution_claim_token = null
  where id = p_old_approval_id and user_id = p_user_id;

  return true;
end;
$$;

create or replace function public.recover_stale_routine_approval_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_approval_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim_token uuid;
begin
  select resume_claim_token
  into v_claim_token
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
    and status = 'running'
    and approval_id = p_approval_id
    and resume_claim_token is not null
    and resume_claim_expires_at <= statement_timestamp()
  for update;
  if not found then return false; end if;

  perform 1 from public.approvals
  where id = p_approval_id and user_id = p_user_id
    and status = 'executing'
    and execution_claim_token = v_claim_token
    and execution_run_id = p_run_id
    and execution_claimed_at <= statement_timestamp() - interval '10 minutes'
  for update;
  if not found then return false; end if;

  -- A timed-out worker may still be executing outside the database. Quarantine
  -- the run instead of making it automatically claimable by a second worker.
  update public.routine_runs
  set status = 'blocked',
      error = 'STALE_RESUME_CLAIM_REQUIRES_REVIEW',
      resume_claim_token = null,
      resume_claimed_at = null,
      resume_claim_expires_at = null,
      completed_at = statement_timestamp()
  where id = p_run_id and user_id = p_user_id
    and resume_claim_token = v_claim_token;

  update public.approvals
  set status = 'expired',
      execution_claim_token = null,
      execution_claimed_at = null,
      execution_run_id = null,
      decided_at = coalesce(decided_at, statement_timestamp())
  where id = p_approval_id and user_id = p_user_id
    and execution_claim_token = v_claim_token;

  return true;
end;
$$;

revoke all on function public.claim_routine_approval_resume(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.renew_routine_approval_resume(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.start_routine_step_under_claim(uuid, uuid, uuid, uuid, text, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.complete_routine_step_under_claim(uuid, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fail_routine_step_under_claim(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.finalize_routine_approval_resume(uuid, uuid, uuid, uuid, text, jsonb, numeric) from public, anon, authenticated, service_role;
revoke all on function public.release_routine_approval_resume(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.repause_routine_approval_resume(uuid, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.recover_stale_routine_approval_resume(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_routine_approval_resume(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.renew_routine_approval_resume(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.start_routine_step_under_claim(uuid, uuid, uuid, uuid, text, integer, jsonb) to service_role;
grant execute on function public.complete_routine_step_under_claim(uuid, uuid, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_routine_step_under_claim(uuid, uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.finalize_routine_approval_resume(uuid, uuid, uuid, uuid, text, jsonb, numeric) to service_role;
grant execute on function public.release_routine_approval_resume(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.repause_routine_approval_resume(uuid, uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.recover_stale_routine_approval_resume(uuid, uuid, uuid) to service_role;

create or replace function public.guard_routine_resume_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'blocked'
     and old.error = 'STALE_RESUME_CLAIM_REQUIRES_REVIEW'
     and new.status = 'running' then
    raise exception 'stale resume claim requires operator review' using errcode = '55000';
  end if;

  if auth.role() = 'authenticated' then
    if new.resume_claim_token is distinct from old.resume_claim_token
       or new.resume_claimed_at is distinct from old.resume_claimed_at
       or new.resume_claim_expires_at is distinct from old.resume_claim_expires_at
       or new.resume_attempt is distinct from old.resume_attempt then
      raise exception 'resume claim fields are server managed' using errcode = '42501';
    end if;
    if old.resume_claim_token is not null then
      raise exception 'claimed routine is server managed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_routine_resume_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists routine_runs_guard_resume_claim on public.routine_runs;
create trigger routine_runs_guard_resume_claim
before update on public.routine_runs
for each row execute function public.guard_routine_resume_claim();

commit;
