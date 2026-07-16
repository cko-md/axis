-- Atomic task / approval lifecycle mutations (expand phase).
--
-- This migration is safe to apply before the matching application deploy: it
-- adds transactional service-role RPCs and integrity constraints but retains
-- the legacy browser-facing grants temporarily. The immediately-following
-- 202607161401 lockdown migration is applied only after the new routes are live.

begin;

do $$
begin
  if exists (
    select 1
    from public.agent_task_activity activity
    join public.agent_tasks task on task.id = activity.task_id
    where task.user_id <> activity.user_id
  ) then
    raise exception 'agent_task_activity contains cross-owner rows';
  end if;

  if exists (
    select 1
    from public.approvals approval
    join public.agent_tasks task on task.id = approval.task_id
    where approval.task_id is not null
      and task.user_id <> approval.user_id
  ) then
    raise exception 'approvals contains cross-owner task links';
  end if;
end
$$;

create unique index if not exists idx_agent_tasks_id_user
  on public.agent_tasks (id, user_id);

alter table public.agent_task_activity
  drop constraint if exists agent_task_activity_owner_fkey;
alter table public.agent_task_activity
  add constraint agent_task_activity_owner_fkey
  foreign key (task_id, user_id)
  references public.agent_tasks (id, user_id)
  on delete cascade
  not valid;

alter table public.approvals
  drop constraint if exists approvals_task_owner_fkey;
alter table public.approvals
  add constraint approvals_task_owner_fkey
  foreign key (task_id, user_id)
  references public.agent_tasks (id, user_id)
  on delete set null (task_id)
  not valid;

alter table public.agent_task_activity
  validate constraint agent_task_activity_owner_fkey;
alter table public.approvals
  validate constraint approvals_task_owner_fkey;

-- Approval creation remains available to owner-scoped application paths, but
-- clients cannot pre-decide or self-attest step-up during insertion.
drop policy if exists "approvals_insert_own" on public.approvals;
create policy "approvals_insert_own"
  on public.approvals for insert
  with check (
    (select auth.uid()) = user_id
    and status = 'pending'
    and decided_at is null
    and step_up_verified_at is null
  );

create or replace function public.create_agent_task_with_activity(
  p_user_id uuid,
  p_objective text,
  p_context jsonb default '{}'::jsonb,
  p_source_routine_id uuid default null,
  p_source_skill text default null,
  p_activity_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.agent_tasks%rowtype;
begin
  if length(trim(coalesce(p_objective, ''))) = 0 or length(p_objective) > 2000 then
    raise exception 'invalid task objective' using errcode = '22023';
  end if;

  insert into public.agent_tasks (
    user_id,
    objective,
    status,
    context,
    source_routine_id,
    source_skill
  )
  values (
    p_user_id,
    trim(p_objective),
    'queued',
    coalesce(p_context, '{}'::jsonb),
    p_source_routine_id,
    p_source_skill
  )
  returning * into v_task;

  insert into public.agent_task_activity (task_id, user_id, kind, detail)
  values (
    v_task.id,
    p_user_id,
    'status_change',
    coalesce(p_activity_detail, '{}'::jsonb)
      || jsonb_build_object('from', null, 'to', 'queued')
  );

  return jsonb_build_object('outcome', 'created', 'task', to_jsonb(v_task));
end;
$$;

-- Canonical fail-closed approval scope predicate. Every privileged creation or
-- execution path calls this helper so malformed legacy/service-written rows
-- cannot become authority. The maximum approval lifetime is 24 hours, and
-- financial execution data must be fresh/delayed and no more than 15 minutes
-- old (with one minute of clock-skew tolerance).
create or replace function public.is_approval_scope_complete(
  p_user_id uuid,
  p_action_class text,
  p_requirement text,
  p_reasons text[],
  p_proposed_action jsonb,
  p_scope text,
  p_expires_at timestamptz,
  p_created_at timestamptz,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_kind text;
  v_actor_id text;
  v_retrieved_at_text text;
  v_retrieved_at timestamptz;
  v_amount numeric;
  v_quantity numeric;
begin
  if p_user_id is null or p_now is null or p_created_at is null then
    return false;
  end if;

  if not coalesce((
    (p_action_class in ('INTERNAL_WRITE', 'EXTERNAL_COMMUNICATION') and p_requirement = 'approval')
    or
    (
      p_action_class in ('FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
      and p_requirement = 'approval_step_up'
    )
  ), false) then
    return false;
  end if;

  if p_scope is null
    or p_scope not in ('one_time', 'persistent')
    or coalesce(array_length(p_reasons, 1), 0) = 0
    or exists (
      select 1
      from unnest(p_reasons) reason
      where length(trim(coalesce(reason, ''))) = 0 or length(reason) > 2000
    )
    or coalesce(jsonb_typeof(p_proposed_action), '') <> 'object'
    or coalesce(jsonb_typeof(p_proposed_action #> '{actor}'), '') <> 'object'
    or coalesce(jsonb_typeof(p_proposed_action #> '{actor,kind}'), '') <> 'string'
    or coalesce(jsonb_typeof(p_proposed_action #> '{actor,id}'), '') <> 'string'
    or coalesce(jsonb_typeof(p_proposed_action -> 'tool'), '') <> 'string'
    or coalesce(jsonb_typeof(p_proposed_action -> 'summary'), '') <> 'string'
    or coalesce(jsonb_typeof(p_proposed_action #> '{target}'), '') <> 'object'
    or coalesce(jsonb_typeof(p_proposed_action #> '{target,entityType}'), '') <> 'string'
  then
    return false;
  end if;

  v_actor_kind := p_proposed_action #>> '{actor,kind}';
  v_actor_id := p_proposed_action #>> '{actor,id}';
  if v_actor_kind not in ('user', 'agent', 'routine')
    or length(trim(v_actor_id)) = 0
    or length(v_actor_id) > 512
    or (
      v_actor_kind = 'user'
      and v_actor_id <> p_user_id::text
    )
    or (
      v_actor_kind = 'routine'
      and (
        coalesce(jsonb_typeof(p_proposed_action #> '{actor,routineVersion}'), '') <> 'number'
        or coalesce(p_proposed_action #>> '{actor,routineVersion}', '') !~ '^[1-9][0-9]{0,9}$'
        or (p_proposed_action #>> '{actor,routineVersion}')::bigint > 2147483647
      )
    )
    or (
      v_actor_kind <> 'routine'
      and (p_proposed_action #> '{actor}') ? 'routineVersion'
    )
  then
    return false;
  end if;

  if length(trim(p_proposed_action ->> 'tool')) = 0
    or length(p_proposed_action ->> 'tool') > 256
    or length(trim(p_proposed_action ->> 'summary')) = 0
    or length(p_proposed_action ->> 'summary') > 2000
    or length(trim(p_proposed_action #>> '{target,entityType}')) = 0
    or length(p_proposed_action #>> '{target,entityType}') > 128
    or (
      (p_proposed_action #> '{target}') ? 'entityId'
      and (
        coalesce(jsonb_typeof(p_proposed_action #> '{target,entityId}'), '') <> 'string'
        or length(trim(p_proposed_action #>> '{target,entityId}')) = 0
        or length(p_proposed_action #>> '{target,entityId}') > 512
      )
    )
    or (
      (p_proposed_action #> '{target}') ? 'accountId'
      and (
        coalesce(jsonb_typeof(p_proposed_action #> '{target,accountId}'), '') <> 'string'
        or length(trim(p_proposed_action #>> '{target,accountId}')) = 0
        or length(p_proposed_action #>> '{target,accountId}') > 512
      )
    )
  then
    return false;
  end if;

  if (
      p_proposed_action ? 'touchesSensitiveData'
      and coalesce(jsonb_typeof(p_proposed_action -> 'touchesSensitiveData'), '') <> 'boolean'
    )
    or (
      p_proposed_action ? 'usesUntrustedExternalContent'
      and coalesce(jsonb_typeof(p_proposed_action -> 'usesUntrustedExternalContent'), '') <> 'boolean'
    )
    or (
      p_proposed_action ? 'explicitlyTrusted'
      and coalesce(jsonb_typeof(p_proposed_action -> 'explicitlyTrusted'), '') <> 'boolean'
    )
  then
    return false;
  end if;

  if p_proposed_action ? 'amount' then
    if coalesce(jsonb_typeof(p_proposed_action -> 'amount'), '') <> 'object'
      or coalesce(jsonb_typeof(p_proposed_action #> '{amount,value}'), '') <> 'number'
      or coalesce(jsonb_typeof(p_proposed_action #> '{amount,currency}'), '') <> 'string'
      or coalesce(p_proposed_action #>> '{amount,currency}', '') !~ '^[A-Z]{3}$'
      or (
        (p_proposed_action -> 'amount') ? 'quantity'
        and coalesce(jsonb_typeof(p_proposed_action #> '{amount,quantity}'), '') <> 'number'
      )
    then
      return false;
    end if;

    begin
      v_amount := (p_proposed_action #>> '{amount,value}')::numeric;
      if v_amount <= 0 then return false; end if;
      if (p_proposed_action -> 'amount') ? 'quantity' then
        v_quantity := (p_proposed_action #>> '{amount,quantity}')::numeric;
        if v_quantity <= 0 then return false; end if;
      end if;
    exception when others then
      return false;
    end;
  end if;

  if p_proposed_action ? 'dataFreshness' then
    if coalesce(jsonb_typeof(p_proposed_action -> 'dataFreshness'), '') <> 'object'
      or coalesce(jsonb_typeof(p_proposed_action #> '{dataFreshness,tier}'), '') <> 'string'
      or (p_proposed_action #>> '{dataFreshness,tier}') not in ('fresh', 'delayed', 'stale', 'unknown')
      or coalesce(jsonb_typeof(p_proposed_action #> '{dataFreshness,retrievedAt}'), '') <> 'string'
    then
      return false;
    end if;

    v_retrieved_at_text := p_proposed_action #>> '{dataFreshness,retrievedAt}';
    if v_retrieved_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$' then
      return false;
    end if;
    begin
      v_retrieved_at := v_retrieved_at_text::timestamptz;
    exception when others then
      return false;
    end;
    if v_retrieved_at > p_now + interval '1 minute' then
      return false;
    end if;
  end if;

  if (
      p_proposed_action ? 'beforeState'
      and coalesce(jsonb_typeof(p_proposed_action -> 'beforeState'), '') <> 'object'
    )
    or (
      p_proposed_action ? 'afterState'
      and coalesce(jsonb_typeof(p_proposed_action -> 'afterState'), '') <> 'object'
    )
  then
    return false;
  end if;

  if p_expires_at is not null
    and (
      p_expires_at <= p_now
      or p_expires_at > p_created_at + interval '24 hours'
    )
  then
    return false;
  end if;

  if p_action_class in ('EXTERNAL_COMMUNICATION', 'FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN')
    and (
      p_expires_at is null
      or not (p_proposed_action ? 'dataFreshness')
    )
  then
    return false;
  end if;

  if p_action_class = 'FINANCIAL_EXECUTION'
    and (
      p_scope <> 'one_time'
      or not (p_proposed_action ? 'amount')
      or not ((p_proposed_action #> '{target}') ? 'accountId')
      or not (p_proposed_action ? 'beforeState')
      or not (p_proposed_action ? 'afterState')
      or (p_proposed_action #>> '{dataFreshness,tier}') not in ('fresh', 'delayed')
      or v_retrieved_at < p_now - interval '15 minutes'
    )
  then
    return false;
  end if;

  if p_action_class = 'DESTRUCTIVE_ADMIN'
    and (
      p_scope <> 'one_time'
      or not (p_proposed_action ? 'beforeState')
    )
  then
    return false;
  end if;

  return true;
exception when others then
  -- Malformed privileged/legacy JSON must fail closed, never abort execution
  -- into an accidentally permissive fallback.
  return false;
end;
$$;

create or replace function public.create_approval_with_activity(
  p_user_id uuid,
  p_task_id uuid,
  p_action_class text,
  p_requirement text,
  p_reasons text[],
  p_proposed_action jsonb,
  p_scope text default 'one_time',
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.approvals%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_approval_scope_complete(
    p_user_id,
    p_action_class,
    p_requirement,
    p_reasons,
    p_proposed_action,
    p_scope,
    p_expires_at,
    v_now,
    v_now
  ) then
    raise exception 'incomplete or invalid approval scope' using errcode = '22023';
  end if;

  insert into public.approvals (
    user_id,
    task_id,
    action_class,
    requirement,
    reasons,
    proposed_action,
    status,
    step_up_verified_at,
    decided_at,
    expires_at,
    scope
  )
  values (
    p_user_id,
    p_task_id,
    p_action_class,
    p_requirement,
    p_reasons,
    p_proposed_action,
    'pending',
    null,
    null,
    p_expires_at,
    p_scope
  )
  returning * into v_approval;

  if v_approval.task_id is not null then
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    values (
      v_approval.task_id,
      p_user_id,
      'approval_request',
      jsonb_build_object(
        'approval_id', v_approval.id,
        'action_class', v_approval.action_class,
        'requirement', v_approval.requirement
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', 'created',
    'approval', to_jsonb(v_approval)
  );
end;
$$;

create or replace function public.cas_agent_task_transition(
  p_user_id uuid,
  p_task_id uuid,
  p_expected_status text,
  p_next_status text,
  p_completed_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.cas_approval_transition(
  p_user_id uuid,
  p_approval_id uuid,
  p_expected_status text,
  p_next_status text,
  p_decided_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.consume_actionable_approval(
  p_user_id uuid,
  p_approval_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.approvals%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_now is null
    or p_now < v_now - interval '1 minute'
    or p_now > v_now + interval '1 minute'
  then
    raise exception 'invalid approval execution timestamp' using errcode = '22023';
  end if;

  select * into v_approval
  from public.approvals
  where id = p_approval_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_approval.status <> 'approved' then
    return jsonb_build_object(
      'outcome', 'conflict',
      'currentStatus', v_approval.status
    );
  end if;

  if exists (
    select 1
    from public.routine_runs
    where user_id = p_user_id
      and approval_id = p_approval_id
      and status in ('waiting_for_approval', 'running')
  ) then
    return jsonb_build_object('outcome', 'routine_owned');
  end if;

  if v_approval.expires_at is not null and v_approval.expires_at <= v_now then
    update public.approvals
    set status = 'expired'
    where id = v_approval.id
    returning * into v_approval;

    if v_approval.task_id is not null then
      insert into public.agent_task_activity (task_id, user_id, kind, detail)
      values (
        v_approval.task_id,
        p_user_id,
        'approval_decision',
        jsonb_build_object(
          'approval_id', v_approval.id,
          'from', 'approved',
          'to', 'expired'
        )
      );
    end if;

    return jsonb_build_object('outcome', 'expired');
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
    return jsonb_build_object('outcome', 'not_actionable');
  end if;

  if v_approval.requirement = 'approval_step_up' then
    if v_approval.step_up_verified_at is null then
      return jsonb_build_object('outcome', 'step_up_required');
    end if;
    if v_approval.step_up_verified_at < v_now - interval '5 minutes'
      or v_approval.step_up_verified_at > v_now + interval '1 minute'
    then
      return jsonb_build_object('outcome', 'step_up_stale');
    end if;
  end if;

  update public.approvals
  set status = 'executed'
  where id = v_approval.id
  returning * into v_approval;

  if v_approval.task_id is not null then
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    values (
      v_approval.task_id,
      p_user_id,
      'approval_decision',
      jsonb_build_object(
        'approval_id', v_approval.id,
        'from', 'approved',
        'to', 'executed'
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', 'updated',
    'approval', to_jsonb(v_approval)
  );
end;
$$;

drop function if exists public.consume_approval_authentication_challenge(
  uuid, uuid, timestamptz
);

create or replace function public.consume_approval_authentication_challenge(
  p_user_id uuid,
  p_approval_id uuid,
  p_challenge_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge public.webauthn_challenges%rowtype;
begin
  delete from public.webauthn_challenges
  where id = p_challenge_id
    and type = 'authentication'
    and user_id = p_user_id
    and approval_id = p_approval_id
    and expires_at > p_now
  returning * into v_challenge;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object(
    'outcome', 'consumed',
    'challengeId', v_challenge.id,
    'challenge', v_challenge.challenge
  );
end;
$$;

create or replace function public.commit_approval_step_up(
  p_user_id uuid,
  p_approval_id uuid,
  p_expected_approval_status text,
  p_passkey_id uuid,
  p_expected_counter bigint,
  p_new_counter bigint,
  p_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.approvals%rowtype;
  v_passkey public.user_passkeys%rowtype;
begin
  select * into v_approval
  from public.approvals
  where id = p_approval_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_approval.requirement <> 'approval_step_up'
    or v_approval.status <> p_expected_approval_status
    or v_approval.status not in ('pending', 'approved')
  then
    return jsonb_build_object(
      'outcome', 'approval_conflict',
      'currentStatus', v_approval.status
    );
  end if;

  select * into v_passkey
  from public.user_passkeys
  where id = p_passkey_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'passkey_not_found');
  end if;

  if v_passkey.counter <> p_expected_counter then
    return jsonb_build_object('outcome', 'counter_conflict');
  end if;

  if p_new_counter < p_expected_counter
    or p_verified_at < now() - interval '1 minute'
    or p_verified_at > now() + interval '1 minute'
  then
    raise exception 'invalid step-up commit values' using errcode = '22023';
  end if;

  update public.user_passkeys
  set
    counter = p_new_counter,
    last_used_at = p_verified_at
  where id = v_passkey.id;

  update public.approvals
  set step_up_verified_at = p_verified_at
  where id = v_approval.id
  returning * into v_approval;

  if v_approval.task_id is not null then
    insert into public.agent_task_activity (task_id, user_id, kind, detail)
    values (
      v_approval.task_id,
      p_user_id,
      'approval_decision',
      jsonb_build_object(
        'approval_id', v_approval.id,
        'event', 'step_up_verified'
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', 'updated',
    'approval', to_jsonb(v_approval)
  );
end;
$$;

create or replace function public.expire_stale_approvals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

drop function if exists public.stamp_approval_step_up(
  uuid, uuid, text, timestamptz
);

revoke all on function public.create_agent_task_with_activity(
  uuid, text, jsonb, uuid, text, jsonb
) from public, anon, authenticated;
revoke all on function public.is_approval_scope_complete(
  uuid, text, text, text[], jsonb, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.create_approval_with_activity(
  uuid, uuid, text, text, text[], jsonb, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.cas_agent_task_transition(
  uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.cas_approval_transition(
  uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.consume_actionable_approval(
  uuid, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.consume_approval_authentication_challenge(
  uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.commit_approval_step_up(
  uuid, uuid, text, uuid, bigint, bigint, timestamptz
) from public, anon, authenticated;
revoke execute on function public.expire_stale_approvals()
  from public, anon, authenticated;

grant execute on function public.create_agent_task_with_activity(
  uuid, text, jsonb, uuid, text, jsonb
) to service_role;
grant execute on function public.is_approval_scope_complete(
  uuid, text, text, text[], jsonb, text, timestamptz, timestamptz, timestamptz
) to service_role;
grant execute on function public.create_approval_with_activity(
  uuid, uuid, text, text, text[], jsonb, text, timestamptz
) to service_role;
grant execute on function public.cas_agent_task_transition(
  uuid, uuid, text, text, timestamptz
) to service_role;
grant execute on function public.cas_approval_transition(
  uuid, uuid, text, text, timestamptz
) to service_role;
grant execute on function public.consume_actionable_approval(
  uuid, uuid, timestamptz
) to service_role;
grant execute on function public.consume_approval_authentication_challenge(
  uuid, uuid, uuid, timestamptz
) to service_role;
grant execute on function public.commit_approval_step_up(
  uuid, uuid, text, uuid, bigint, bigint, timestamptz
) to service_role;
grant execute on function public.expire_stale_approvals() to service_role;

commit;
