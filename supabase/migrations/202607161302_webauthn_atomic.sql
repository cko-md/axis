-- Atomic WebAuthn ceremony consumption and passkey persistence.
--
-- Passkeys prove possession; they do not persist Supabase refresh tokens.
-- After a valid assertion and counter CAS, the server issues a fresh Supabase
-- session through the service-role magic-link flow and writes server-managed
-- session cookies. No token crosses the API response boundary.

begin;

-- Remove draft overloads so a local re-apply cannot leave an executable token
-- storage path behind.
drop function if exists public.create_user_passkey(
  uuid, text, text, bigint, text, boolean, text[], text, text
);
drop function if exists public.create_user_passkey(
  uuid, text, text, bigint, text, boolean, text[], text
);
drop function if exists public.commit_passkey_authentication(
  uuid, uuid, bigint, bigint, text, text, timestamptz
);
drop function if exists public.commit_passkey_authentication(
  uuid, uuid, bigint, bigint, timestamptz
);
drop function if exists public.commit_passkey_authentication(
  uuid, uuid, bigint, bigint, timestamptz, timestamptz
);
drop function if exists public.sync_user_passkey_session(uuid, text);
drop function if exists public.delete_user_passkey(uuid, uuid);

create or replace function public.consume_webauthn_challenge(
  p_challenge_id uuid,
  p_type text,
  p_user_id uuid,
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
$$;

create or replace function public.create_user_passkey(
  p_user_id uuid,
  p_credential_id text,
  p_credential_public_key text,
  p_counter bigint,
  p_device_type text,
  p_backed_up boolean,
  p_transports text[],
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_passkey public.user_passkeys%rowtype;
begin
  if p_user_id is null
    or nullif(btrim(p_credential_id), '') is null
    or nullif(btrim(p_credential_public_key), '') is null
    or p_counter is null
    or p_counter < 0
    or (p_device_type is not null and p_device_type not in ('platform', 'cross-platform'))
    or p_backed_up is null
    or nullif(btrim(p_name), '') is null
    or char_length(btrim(p_name)) > 100
  then
    raise exception 'invalid passkey registration values'
      using errcode = '22023';
  end if;

  -- Serialize create/delete for one user so passkey_enabled cannot diverge.
  perform 1
  from auth.users
  where id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'user_not_found');
  end if;

  begin
    insert into public.user_passkeys (
      user_id,
      credential_id,
      credential_public_key,
      counter,
      device_type,
      backed_up,
      transports,
      name
    )
    values (
      p_user_id,
      p_credential_id,
      p_credential_public_key,
      p_counter,
      p_device_type,
      p_backed_up,
      coalesce(p_transports, array[]::text[]),
      btrim(p_name)
    )
    returning * into v_passkey;
  exception
    when unique_violation then
      return jsonb_build_object('outcome', 'credential_exists');
  end;

  insert into public.user_auth_settings (
    user_id,
    passkey_enabled,
    biometric_prompted,
    updated_at
  )
  values (
    p_user_id,
    true,
    true,
    now()
  )
  on conflict (user_id) do update
  set
    passkey_enabled = true,
    biometric_prompted = true,
    updated_at = now();

  return jsonb_build_object(
    'outcome', 'created',
    'passkeyId', v_passkey.id
  );
end;
$$;

create or replace function public.commit_passkey_authentication(
  p_user_id uuid,
  p_passkey_id uuid,
  p_expected_counter bigint,
  p_new_counter bigint,
  p_expected_last_used_at timestamptz,
  p_used_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.delete_user_passkey(
  p_user_id uuid,
  p_passkey_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_id uuid;
  v_remaining_count integer;
begin
  if p_user_id is null or p_passkey_id is null then
    raise exception 'invalid passkey deletion values'
      using errcode = '22023';
  end if;

  -- Two concurrent "delete the last passkey" requests must serialize or both
  -- can observe one remaining row and leave passkey_enabled incorrectly true.
  perform 1
  from auth.users
  where id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  delete from public.user_passkeys
  where id = p_passkey_id
    and user_id = p_user_id
  returning id into v_deleted_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select count(*)::integer into v_remaining_count
  from public.user_passkeys
  where user_id = p_user_id;

  insert into public.user_auth_settings (
    user_id,
    passkey_enabled,
    updated_at
  )
  values (
    p_user_id,
    v_remaining_count > 0,
    now()
  )
  on conflict (user_id) do update
  set
    passkey_enabled = excluded.passkey_enabled,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'outcome', 'deleted',
    'hasPasskeys', v_remaining_count > 0
  );
end;
$$;

revoke all on function public.consume_webauthn_challenge(
  uuid, text, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.create_user_passkey(
  uuid, text, text, bigint, text, boolean, text[], text
) from public, anon, authenticated;
revoke all on function public.commit_passkey_authentication(
  uuid, uuid, bigint, bigint, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.delete_user_passkey(
  uuid, uuid
) from public, anon, authenticated;

grant execute on function public.consume_webauthn_challenge(
  uuid, text, uuid, timestamptz
) to service_role;
grant execute on function public.create_user_passkey(
  uuid, text, text, bigint, text, boolean, text[], text
) to service_role;
grant execute on function public.commit_passkey_authentication(
  uuid, uuid, bigint, bigint, timestamptz, timestamptz
) to service_role;
grant execute on function public.delete_user_passkey(
  uuid, uuid
) to service_role;

commit;
