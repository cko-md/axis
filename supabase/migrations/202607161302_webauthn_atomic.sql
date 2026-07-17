-- 202607161302_webauthn_atomic.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live function bodies
-- (pg_get_functiondef) on 2026-07-17.
--
-- Atomic compare-and-swap commits for WebAuthn/passkey flows: passkey
-- counter advancement (replay-attack defense — a counter that doesn't
-- strictly increase means a cloned authenticator), step-up approval
-- verification, and one-time-use challenge consumption. All state changes
-- are `where <expected current state>` UPDATE/DELETE ... RETURNING so two
-- concurrent verification attempts can't both succeed.

create or replace function public.commit_approval_step_up(p_user_id uuid, p_approval_id uuid, p_expected_approval_status text, p_passkey_id uuid, p_expected_counter bigint, p_new_counter bigint, p_verified_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.commit_approval_step_up(uuid, uuid, text, uuid, bigint, bigint, timestamptz) from public;
grant execute on function public.commit_approval_step_up(uuid, uuid, text, uuid, bigint, bigint, timestamptz) to service_role;

create or replace function public.commit_passkey_authentication(p_user_id uuid, p_passkey_id uuid, p_expected_counter bigint, p_new_counter bigint, p_expected_last_used_at timestamptz, p_used_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_passkey_id uuid;
begin
  if p_user_id is null
    or p_passkey_id is null
    or p_expected_counter is null
    or p_new_counter is null
    or p_expected_counter < 0
    or p_new_counter < p_expected_counter
    or p_used_at is null
    or p_used_at < now() - interval '1 minute'
    or p_used_at > now() + interval '1 minute'
  then
    raise exception 'invalid passkey authentication commit values'
      using errcode = '22023';
  end if;

  update public.user_passkeys
  set
    counter = p_new_counter,
    last_used_at = greatest(
      coalesce(last_used_at, '-infinity'::timestamptz),
      p_used_at,
      clock_timestamp()
    )
  where id = p_passkey_id
    and user_id = p_user_id
    and counter = p_expected_counter
    and last_used_at is not distinct from p_expected_last_used_at
  returning id into v_passkey_id;

  if found then
    return jsonb_build_object('outcome', 'updated');
  end if;

  if exists (
    select 1
    from public.user_passkeys
    where id = p_passkey_id
      and user_id = p_user_id
  ) then
    return jsonb_build_object('outcome', 'counter_conflict');
  end if;

  return jsonb_build_object('outcome', 'passkey_not_found');
end;
$function$;

revoke all on function public.commit_passkey_authentication(uuid, uuid, bigint, bigint, timestamptz, timestamptz) from public;
grant execute on function public.commit_passkey_authentication(uuid, uuid, bigint, bigint, timestamptz, timestamptz) to service_role;

create or replace function public.consume_webauthn_challenge(p_challenge_id uuid, p_type text, p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_challenge public.webauthn_challenges%rowtype;
begin
  if p_challenge_id is null
    or p_type not in ('registration', 'authentication')
    or (p_type = 'registration' and p_user_id is null)
    or (p_type = 'authentication' and p_user_id is not null)
  then
    raise exception 'invalid WebAuthn challenge consume values'
      using errcode = '22023';
  end if;

  delete from public.webauthn_challenges
  where id = p_challenge_id
    and type = p_type
    and expires_at > p_now
    and approval_id is null
    and (
      (p_type = 'registration' and user_id = p_user_id)
      or (p_type = 'authentication' and user_id is null)
    )
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
$function$;

revoke all on function public.consume_webauthn_challenge(uuid, text, uuid, timestamptz) from public;
grant execute on function public.consume_webauthn_challenge(uuid, text, uuid, timestamptz) to service_role;

create or replace function public.consume_approval_authentication_challenge(p_user_id uuid, p_approval_id uuid, p_challenge_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.consume_approval_authentication_challenge(uuid, uuid, uuid, timestamptz) from public;
grant execute on function public.consume_approval_authentication_challenge(uuid, uuid, uuid, timestamptz) to service_role;
