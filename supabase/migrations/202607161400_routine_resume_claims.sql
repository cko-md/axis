-- Fenced routine-resume execution (expand phase).
--
-- Adds lease-backed resume claims and service-role-only transactional RPCs
-- without removing the legacy owner-scoped table policies. Browser writes are
-- rejected only when they attempt to forge claim state or mutate a run while
-- a trusted executor owns an active claim. A later contract migration may
-- remove the remaining direct-write policies after every caller uses the RPCs.

begin;

do $$
begin
  if exists (
    select 1
    from public.routine_step_runs step_run
    join public.routine_runs run on run.id = step_run.run_id
    where run.user_id <> step_run.user_id
  ) then
    raise exception 'routine_step_runs contains cross-owner run links';
  end if;

  if exists (
    select 1
    from public.routine_step_runs
    where status = 'running'
    group by run_id, step_key
    having count(*) > 1
  ) then
    raise exception 'routine_step_runs contains duplicate running steps';
  end if;
end
$$;

alter table public.routine_runs
  add column if not exists resume_claim_token uuid,
  add column if not exists resume_claimed_at timestamptz,
  add column if not exists resume_claim_expires_at timestamptz,
  add column if not exists resume_attempt integer not null default 0;

alter table public.agent_tasks
  add column if not exists idempotency_key text;

alter table public.agent_tasks
  drop constraint if exists agent_tasks_idempotency_key_check;
alter table public.agent_tasks
  add constraint agent_tasks_idempotency_key_check
  check (
    idempotency_key is null
    or (
      length(trim(idempotency_key)) > 0
      and length(idempotency_key) <= 512
    )
  )
  not valid;

alter table public.routine_runs
  drop constraint if exists routine_runs_resume_claim_fields_check;
alter table public.routine_runs
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
  )
  not valid;

alter table public.routine_runs
  drop constraint if exists routine_runs_resume_claim_status_check;
alter table public.routine_runs
  add constraint routine_runs_resume_claim_status_check
  check (resume_claim_token is null or status = 'running')
  not valid;

alter table public.routine_runs
  drop constraint if exists routine_runs_resume_claim_window_check;
alter table public.routine_runs
  add constraint routine_runs_resume_claim_window_check
  check (
    resume_claim_token is null
    or resume_claim_expires_at > resume_claimed_at
  )
  not valid;

alter table public.routine_runs
  drop constraint if exists routine_runs_resume_attempt_check;
alter table public.routine_runs
  add constraint routine_runs_resume_attempt_check
  check (resume_attempt >= 0)
  not valid;

alter table public.routine_runs
  validate constraint routine_runs_resume_claim_fields_check;
alter table public.routine_runs
  validate constraint routine_runs_resume_claim_status_check;
alter table public.routine_runs
  validate constraint routine_runs_resume_claim_window_check;
alter table public.routine_runs
  validate constraint routine_runs_resume_attempt_check;
alter table public.agent_tasks
  validate constraint agent_tasks_idempotency_key_check;

-- Older executor pauses allowed a null key. Give each resumable pause a stable,
-- deterministic key before the claim path starts requiring complete metadata.
update public.routine_runs
set idempotency_key =
  'routine-resume:' || id::text || ':' || paused_step_key
where status = 'waiting_for_approval'
  and paused_step_key is not null
  and approval_id is not null
  and nullif(trim(idempotency_key), '') is null;

create unique index if not exists idx_routine_runs_id_user
  on public.routine_runs (id, user_id);

alter table public.routine_step_runs
  drop constraint if exists routine_step_runs_run_owner_fkey;
alter table public.routine_step_runs
  add constraint routine_step_runs_run_owner_fkey
  foreign key (run_id, user_id)
  references public.routine_runs (id, user_id)
  on delete cascade
  not valid;
alter table public.routine_step_runs
  validate constraint routine_step_runs_run_owner_fkey;

create unique index if not exists idx_routine_step_runs_one_running_step
  on public.routine_step_runs (run_id, step_key)
  where status = 'running';

create unique index if not exists idx_routine_runs_resume_claim_token
  on public.routine_runs (resume_claim_token)
  where resume_claim_token is not null;

create index if not exists idx_routine_runs_resume_claim_expiry
  on public.routine_runs (resume_claim_expires_at)
  where resume_claim_token is not null;

create unique index if not exists idx_agent_tasks_user_idempotency_key
  on public.agent_tasks (user_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.guard_claimed_routine_run_browser_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.resume_claim_token is not null
        or new.resume_claimed_at is not null
        or new.resume_claim_expires_at is not null
        or new.resume_attempt <> 0
      then
        raise exception 'routine resume claims are server-managed'
          using errcode = '42501';
      end if;
    elsif old.resume_claim_token is not null
      or new.resume_claim_token is distinct from old.resume_claim_token
      or new.resume_claimed_at is distinct from old.resume_claimed_at
      or new.resume_claim_expires_at is distinct from old.resume_claim_expires_at
      or new.resume_attempt is distinct from old.resume_attempt
    then
      raise exception 'claimed routine runs are server-managed'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_claimed_routine_run_browser_write
  on public.routine_runs;
create trigger guard_claimed_routine_run_browser_write
  before insert or update on public.routine_runs
  for each row execute function public.guard_claimed_routine_run_browser_write();

create or replace function public.guard_claimed_routine_step_browser_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_claimed boolean := false;
begin
  if current_user not in ('anon', 'authenticated') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    select exists (
      select 1
      from public.routine_runs
      where id = new.run_id
        and user_id = new.user_id
        and resume_claim_token is not null
    )
    into v_claimed;
  elsif tg_op = 'UPDATE' then
    select exists (
      select 1
      from public.routine_runs
      where resume_claim_token is not null
        and (
          (id = old.run_id and user_id = old.user_id)
          or
          (id = new.run_id and user_id = new.user_id)
        )
    )
    into v_claimed;
  else
    select exists (
      select 1
      from public.routine_runs
      where id = old.run_id
        and user_id = old.user_id
        and resume_claim_token is not null
    )
    into v_claimed;
  end if;

  if v_claimed then
    raise exception 'claimed routine steps are server-managed'
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_claimed_routine_step_browser_write
  on public.routine_step_runs;
create trigger guard_claimed_routine_step_browser_write
  before insert or update or delete on public.routine_step_runs
  for each row execute function public.guard_claimed_routine_step_browser_write();

create or replace function public.claim_routine_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.renew_routine_resume_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.release_routine_resume_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.repause_routine_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_step_key text,
  p_approval_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.complete_routine_resume(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_status text,
  p_output jsonb,
  p_actual_cost_usd numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.start_claimed_routine_step(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_step_key text,
  p_ordinal integer,
  p_input_snapshot jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
  v_step public.routine_step_runs%rowtype;
  v_attempt integer;
begin
  if p_claim_token is null then
    raise exception 'claim token is required' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_step_key, ''))) = 0
    or length(p_step_key) > 256
    or p_ordinal is null
    or p_ordinal < 1
  then
    raise exception 'invalid routine step metadata' using errcode = '22023';
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

  select * into v_step
  from public.routine_step_runs
  where run_id = p_run_id
    and user_id = p_user_id
    and step_key = trim(p_step_key)
    and status = 'running'
  order by created_at desc
  limit 1
  for update;

  if found then
    if v_step.ordinal <> p_ordinal
      or coalesce(v_step.input_snapshot, '{}'::jsonb)
        is distinct from coalesce(p_input_snapshot, '{}'::jsonb)
    then
      return jsonb_build_object(
        'outcome', 'step_conflict',
        'currentStatus', 'running_metadata_mismatch'
      );
    end if;
    return jsonb_build_object(
      'outcome', 'started',
      'step', to_jsonb(v_step),
      'reused', true
    );
  end if;

  select * into v_step
  from public.routine_step_runs
  where run_id = p_run_id
    and user_id = p_user_id
    and step_key = trim(p_step_key)
    and status = 'succeeded'
  order by completed_at desc nulls last, created_at desc
  limit 1;

  if found then
    if v_step.ordinal <> p_ordinal
      or coalesce(v_step.input_snapshot, '{}'::jsonb)
        is distinct from coalesce(p_input_snapshot, '{}'::jsonb)
    then
      return jsonb_build_object(
        'outcome', 'step_conflict',
        'currentStatus', 'succeeded_metadata_mismatch'
      );
    end if;
    return jsonb_build_object(
      'outcome', 'already_succeeded',
      'step', to_jsonb(v_step)
    );
  end if;

  select coalesce(max(attempt), 0) + 1
  into v_attempt
  from public.routine_step_runs
  where run_id = p_run_id
    and user_id = p_user_id
    and step_key = trim(p_step_key);

  insert into public.routine_step_runs (
    run_id,
    user_id,
    step_key,
    ordinal,
    status,
    input_snapshot,
    attempt,
    started_at
  )
  values (
    p_run_id,
    p_user_id,
    trim(p_step_key),
    p_ordinal,
    'running',
    coalesce(p_input_snapshot, '{}'::jsonb),
    v_attempt,
    v_now
  )
  returning * into v_step;

  return jsonb_build_object(
    'outcome', 'started',
    'step', to_jsonb(v_step),
    'reused', false
  );
end;
$$;

create or replace function public.complete_claimed_routine_step(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_step_run_id uuid,
  p_output_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
  v_step public.routine_step_runs%rowtype;
begin
  if p_claim_token is null or p_step_run_id is null then
    raise exception 'claim token and step run are required' using errcode = '22023';
  end if;

  select * into v_run
  from public.routine_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_run.status in ('completed', 'partial') then
    select * into v_step
    from public.routine_step_runs
    where id = p_step_run_id
      and run_id = p_run_id
      and user_id = p_user_id;

    if found
      and v_step.status = 'succeeded'
      and v_step.output_snapshot is not distinct from p_output_snapshot
    then
      return jsonb_build_object(
        'outcome', 'completed',
        'step', to_jsonb(v_step),
        'reused', true
      );
    end if;
    if found and v_step.status = 'succeeded' then
      return jsonb_build_object(
        'outcome', 'step_conflict',
        'currentStatus', 'succeeded_output_mismatch'
      );
    end if;
    return jsonb_build_object('outcome', 'terminal', 'status', v_run.status);
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

  select * into v_step
  from public.routine_step_runs
  where id = p_step_run_id
    and run_id = p_run_id
    and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'step_not_found');
  end if;
  if v_step.status = 'succeeded' then
    if v_step.output_snapshot is distinct from p_output_snapshot then
      return jsonb_build_object(
        'outcome', 'step_conflict',
        'currentStatus', 'succeeded_output_mismatch'
      );
    end if;
    return jsonb_build_object(
      'outcome', 'completed',
      'step', to_jsonb(v_step),
      'reused', true
    );
  end if;
  if v_step.status <> 'running' then
    return jsonb_build_object(
      'outcome', 'step_conflict',
      'currentStatus', v_step.status
    );
  end if;

  update public.routine_step_runs
  set
    status = 'succeeded',
    output_snapshot = p_output_snapshot,
    error = null,
    completed_at = v_now
  where id = v_step.id
  returning * into v_step;

  return jsonb_build_object(
    'outcome', 'completed',
    'step', to_jsonb(v_step),
    'reused', false
  );
end;
$$;

create or replace function public.fail_claimed_routine_step(
  p_user_id uuid,
  p_run_id uuid,
  p_claim_token uuid,
  p_step_run_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run public.routine_runs%rowtype;
  v_step public.routine_step_runs%rowtype;
begin
  if p_claim_token is null or p_step_run_id is null then
    raise exception 'claim token and step run are required' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_error_code, ''))) = 0 or length(p_error_code) > 128 then
    raise exception 'invalid routine step error code' using errcode = '22023';
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

  select * into v_step
  from public.routine_step_runs
  where id = p_step_run_id
    and run_id = p_run_id
    and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'step_not_found');
  end if;
  if v_step.status = 'failed' then
    if v_step.error is distinct from trim(p_error_code) then
      return jsonb_build_object(
        'outcome', 'step_conflict',
        'currentStatus', 'failed_error_mismatch'
      );
    end if;
    return jsonb_build_object(
      'outcome', 'failed',
      'step', to_jsonb(v_step),
      'reused', true
    );
  end if;
  if v_step.status <> 'running' then
    return jsonb_build_object(
      'outcome', 'step_conflict',
      'currentStatus', v_step.status
    );
  end if;

  update public.routine_step_runs
  set
    status = 'failed',
    error = trim(p_error_code),
    completed_at = v_now
  where id = v_step.id
  returning * into v_step;

  return jsonb_build_object(
    'outcome', 'failed',
    'step', to_jsonb(v_step),
    'reused', false
  );
end;
$$;

create or replace function public.create_idempotent_agent_task_with_activity(
  p_user_id uuid,
  p_objective text,
  p_context jsonb default '{}'::jsonb,
  p_source_routine_id uuid default null,
  p_source_skill text default null,
  p_activity_detail jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.agent_tasks%rowtype;
begin
  if length(trim(coalesce(p_objective, ''))) = 0
    or length(p_objective) > 2000
  then
    raise exception 'invalid task objective' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) = 0
    or length(p_idempotency_key) > 512
  then
    raise exception 'invalid task idempotency key' using errcode = '22023';
  end if;
  if p_source_routine_id is not null
    and not exists (
      select 1
      from public.routine_runs
      where id = p_source_routine_id
        and user_id = p_user_id
    )
  then
    raise exception 'invalid task source routine' using errcode = '22023';
  end if;

  insert into public.agent_tasks (
    user_id,
    objective,
    status,
    context,
    source_routine_id,
    source_skill,
    idempotency_key
  )
  values (
    p_user_id,
    trim(p_objective),
    'queued',
    coalesce(p_context, '{}'::jsonb),
    p_source_routine_id,
    p_source_skill,
    trim(p_idempotency_key)
  )
  on conflict (user_id, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_task;

  if not found then
    select * into v_task
    from public.agent_tasks
    where user_id = p_user_id
      and idempotency_key = trim(p_idempotency_key);

    if not found then
      raise exception 'idempotent task lookup failed';
    end if;

    if v_task.objective <> trim(p_objective)
      or v_task.context is distinct from coalesce(p_context, '{}'::jsonb)
      or v_task.source_routine_id is distinct from p_source_routine_id
      or v_task.source_skill is distinct from p_source_skill
    then
      return jsonb_build_object(
        'outcome', 'conflict',
        'currentStatus', v_task.status,
        'reason', 'idempotency_payload_mismatch'
      );
    end if;

    return jsonb_build_object(
      'outcome', 'existing',
      'task', to_jsonb(v_task)
    );
  end if;

  insert into public.agent_task_activity (task_id, user_id, kind, detail)
  values (
    v_task.id,
    p_user_id,
    'status_change',
    coalesce(p_activity_detail, '{}'::jsonb)
      || jsonb_build_object(
        'from', null,
        'to', 'queued',
        'idempotency_key', v_task.idempotency_key
      )
  );

  return jsonb_build_object(
    'outcome', 'created',
    'task', to_jsonb(v_task)
  );
end;
$$;

revoke all on function public.guard_claimed_routine_run_browser_write()
  from public, anon, authenticated;
revoke all on function public.guard_claimed_routine_step_browser_write()
  from public, anon, authenticated;

revoke all on function public.claim_routine_resume(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.renew_routine_resume_claim(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_routine_resume_claim(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.repause_routine_resume(
  uuid, uuid, uuid, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.complete_routine_resume(
  uuid, uuid, uuid, text, jsonb, numeric
) from public, anon, authenticated;
revoke all on function public.start_claimed_routine_step(
  uuid, uuid, uuid, text, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.complete_claimed_routine_step(
  uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_claimed_routine_step(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.create_idempotent_agent_task_with_activity(
  uuid, text, jsonb, uuid, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.claim_routine_resume(
  uuid, uuid, uuid, integer
) to service_role;
grant execute on function public.renew_routine_resume_claim(
  uuid, uuid, uuid, integer
) to service_role;
grant execute on function public.release_routine_resume_claim(
  uuid, uuid, uuid, text
) to service_role;
grant execute on function public.repause_routine_resume(
  uuid, uuid, uuid, text, uuid, text
) to service_role;
grant execute on function public.complete_routine_resume(
  uuid, uuid, uuid, text, jsonb, numeric
) to service_role;
grant execute on function public.start_claimed_routine_step(
  uuid, uuid, uuid, text, integer, jsonb
) to service_role;
grant execute on function public.complete_claimed_routine_step(
  uuid, uuid, uuid, uuid, jsonb
) to service_role;
grant execute on function public.fail_claimed_routine_step(
  uuid, uuid, uuid, uuid, text
) to service_role;
grant execute on function public.create_idempotent_agent_task_with_activity(
  uuid, text, jsonb, uuid, text, jsonb, text
) to service_role;

commit;
