-- Provider identity authority (expand phase).
-- This migration is additive: existing browser access remains until the
-- compatible application is live and the lexical-tail contract migration is
-- explicitly approved. Existing public rows never become authority by virtue
-- of their `ACTIVE` string; only service-owned membership below can authorize.
begin;

alter table public.composio_connections
  add column if not exists remote_verified_at timestamptz,
  add column if not exists verification_error_code text,
  add column if not exists lifecycle_version bigint not null default 0;

create index if not exists idx_composio_connections_owner_toolkit_lifecycle
  on public.composio_connections (user_id, toolkit, id, lifecycle_version);
create unique index if not exists composio_connections_id_user_id_key
  on public.composio_connections (id, user_id);
create unique index if not exists composio_connections_identity_binding_key
  on public.composio_connections (id, user_id, toolkit, connected_account_id, auth_config_id);

create table if not exists public.composio_connection_authorities (
  connection_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  toolkit text not null check (toolkit in ('gmail', 'outlook', 'googlecalendar', 'googlecontacts', 'strava', 'spotify')),
  connected_account_id text not null,
  auth_config_id text not null,
  lifecycle_state text not null check (lifecycle_state in ('INITIATED', 'ACTIVE', 'DISCONNECTING', 'REVOKED', 'FAILED')),
  remote_verified_at timestamptz,
  last_observation text not null default 'UNKNOWN' check (last_observation in ('ACTIVE', 'UNKNOWN', 'RECONNECT_REQUIRED')),
  observed_at timestamptz,
  lifecycle_version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, toolkit, connected_account_id),
  unique (connected_account_id),
  foreign key (connection_id, user_id, toolkit, connected_account_id, auth_config_id)
    references public.composio_connections (id, user_id, toolkit, connected_account_id, auth_config_id) on delete cascade
);
alter table public.composio_connection_authorities
  drop constraint if exists composio_connection_authorities_lifecycle_state_check;
alter table public.composio_connection_authorities
  add constraint composio_connection_authorities_lifecycle_state_check
  check (lifecycle_state in ('INITIATED', 'ACTIVE', 'DISCONNECTING', 'REVOKED', 'FAILED', 'SUPERSEDED'));
create unique index if not exists composio_connection_authorities_single_toolkit_active_key
  on public.composio_connection_authorities (user_id, toolkit)
  where toolkit not in ('gmail', 'outlook') and lifecycle_state = 'ACTIVE';
alter table public.composio_connection_authorities enable row level security;
revoke all on public.composio_connection_authorities from public, anon, authenticated;
grant select, insert, update, delete on public.composio_connection_authorities to service_role;

-- Opaque internal references can be populated by the compatible application
-- for newly verified connections. No data rewrite occurs here: legacy cache
-- rows remain recoverable through the expand window, but cannot authorize an
-- action because they lack private authority membership.
alter table public.mail_message_cache
  add column if not exists composio_connection_id uuid;
alter table public.mail_message_cache
  add constraint mail_message_cache_connection_owner_fkey
  foreign key (composio_connection_id, user_id)
  references public.composio_connections (id, user_id) on delete cascade;
alter table public.mail_message_cache
  drop constraint if exists mail_message_cache_check;
alter table public.mail_message_cache
  add constraint mail_message_cache_connection_identity_check check (
    (transport = 'composio' and (composio_connection_id is not null or connected_account_id is not null))
    or (transport = 'direct' and composio_connection_id is null)
  );
-- NOT VALID retains unmatched legacy rows, while PostgreSQL still enforces the
-- opaque ref on every new Composio insert/update from this migration onward.
alter table public.mail_message_cache
  add constraint mail_message_cache_composio_opaque_ref_required
  check (transport <> 'composio' or composio_connection_id is not null) not valid;
alter table public.integration_sync_state
  add column if not exists composio_connection_id uuid;
alter table public.integration_sync_state
  add constraint integration_sync_state_connection_owner_fkey
  foreign key (composio_connection_id, user_id)
  references public.composio_connections (id, user_id) on delete cascade;
alter table public.integration_sync_state
  add constraint integration_sync_state_composio_opaque_ref_required
  check (transport <> 'composio' or composio_connection_id is not null) not valid;

-- Safe legacy backfill only joins the same owner, exact provider/toolkit, and
-- exact remote account id. Unmatched legacy rows remain readable in expand but
-- are quarantined from authority; contract will require opaque references.
update public.mail_message_cache as cache
set composio_connection_id = connection.id,
    account_ref = connection.id::text
from public.composio_connections as connection
where cache.transport = 'composio'
  and cache.composio_connection_id is null
  and cache.user_id = connection.user_id
  and cache.provider = connection.toolkit
  and cache.connected_account_id = connection.connected_account_id;

update public.integration_sync_state as sync
set composio_connection_id = connection.id,
    account_ref = connection.id::text
from public.composio_connections as connection
where sync.transport = 'composio'
  and sync.composio_connection_id is null
  and sync.user_id = connection.user_id
  and sync.account_ref = connection.connected_account_id;

create or replace view public.composio_connection_status
with (security_barrier = true)
as
select
  connection.id,
  connection.toolkit,
  case
    when authority.last_observation = 'UNKNOWN' then 'UNKNOWN'
    when authority.lifecycle_state in ('DISCONNECTING', 'REVOKED', 'SUPERSEDED')
      or authority.last_observation = 'RECONNECT_REQUIRED' then 'RECONNECT_REQUIRED'
    when authority.lifecycle_state = 'ACTIVE'
      and authority.last_observation = 'ACTIVE'
      and authority.remote_verified_at between now() - interval '10 minutes' and now() + interval '1 minute'
      then 'ACTIVE'
    else 'RECONNECT_REQUIRED'
  end as status,
  connection.account_label,
  connection.created_at,
  connection.updated_at,
  case when authority.lifecycle_state = 'ACTIVE'
      and authority.last_observation = 'ACTIVE'
      and authority.remote_verified_at between now() - interval '10 minutes' and now() + interval '1 minute'
    then authority.remote_verified_at else null end as remote_verified_at
from public.composio_connections as connection
left join public.composio_connection_authorities as authority
  on authority.connection_id = connection.id and authority.user_id = connection.user_id
where connection.user_id = (select auth.uid());
revoke all on public.composio_connection_status from public, anon;
grant select on public.composio_connection_status to authenticated;

-- The server calls these functions through service_role so public lifecycle
-- projection and private authority membership move atomically. SECURITY
-- DEFINER functions pin search_path and qualify every object to avoid search
-- path shadowing; browser roles receive no EXECUTE grant.
create or replace function public.axis_create_composio_connection_authority(
  p_connection_id uuid,
  p_user_id uuid,
  p_toolkit text,
  p_connected_account_id text,
  p_auth_config_id text,
  p_status text,
  p_account_label text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_id uuid;
begin
  if p_toolkit not in ('gmail', 'outlook', 'googlecalendar', 'googlecontacts', 'strava', 'spotify')
    or p_connected_account_id is null or length(p_connected_account_id) not between 1 and 256
    or p_auth_config_id is null or length(p_auth_config_id) not between 1 and 256
    or p_status not in ('INITIATED', 'INITIALIZING', 'PENDING')
    or (p_account_label is not null and length(p_account_label) > 320) then
    raise exception 'invalid provider connection authority input' using errcode = '22023';
  end if;
  insert into public.composio_connections (
    id, user_id, toolkit, connected_account_id, auth_config_id, status, account_label, lifecycle_version
  ) values (
    p_connection_id, p_user_id, p_toolkit, p_connected_account_id, p_auth_config_id, p_status, p_account_label, 0
  ) returning id into v_connection_id;

  insert into public.composio_connection_authorities (
    connection_id, user_id, toolkit, connected_account_id, auth_config_id, lifecycle_state, lifecycle_version
  ) values (
    v_connection_id, p_user_id, p_toolkit, p_connected_account_id, p_auth_config_id, 'INITIATED', 0
  );
  return v_connection_id;
end;
$$;

create or replace function public.axis_transition_composio_connection_authority(
  p_connection_id uuid,
  p_user_id uuid,
  p_expected_state text,
  p_expected_version bigint,
  p_next_state text,
  p_remote_verified_at timestamptz,
  p_public_status text,
  p_verification_error_code text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_expected_state not in ('INITIATED', 'ACTIVE', 'FAILED', 'DISCONNECTING', 'REVOKED', 'SUPERSEDED')
    or p_next_state not in ('ACTIVE', 'FAILED', 'REVOKED', 'DISCONNECTING')
    or p_public_status not in ('ACTIVE', 'UNVERIFIED', 'RECONNECT_REQUIRED')
    or (p_verification_error_code is not null and length(p_verification_error_code) > 96) then
    raise exception 'invalid authority lifecycle transition' using errcode = '22023';
  end if;
  if (p_next_state = 'ACTIVE' and (p_public_status <> 'ACTIVE' or p_remote_verified_at is null
      or p_remote_verified_at > now() + interval '1 minute'
      or p_remote_verified_at < now() - interval '10 minutes'))
    or (p_next_state <> 'ACTIVE' and (p_public_status = 'ACTIVE' or p_remote_verified_at is not null)) then
    raise exception 'authority/public status or proof timestamp is invalid' using errcode = '22023';
  end if;
  if (p_expected_state = 'INITIATED' and p_next_state not in ('ACTIVE', 'FAILED', 'DISCONNECTING', 'REVOKED'))
    or (p_expected_state = 'ACTIVE' and p_next_state not in ('ACTIVE', 'FAILED', 'DISCONNECTING', 'REVOKED'))
    or (p_expected_state = 'FAILED' and p_next_state not in ('FAILED', 'REVOKED'))
    or (p_expected_state = 'DISCONNECTING' and p_next_state <> 'REVOKED')
    or p_expected_state in ('REVOKED', 'SUPERSEDED') then
    raise exception 'invalid monotonic authority lifecycle transition' using errcode = '22023';
  end if;
  update public.composio_connection_authorities
  set lifecycle_state = p_next_state,
      remote_verified_at = p_remote_verified_at,
      last_observation = case when p_next_state = 'ACTIVE' then 'ACTIVE' else 'RECONNECT_REQUIRED' end,
      observed_at = now(),
      lifecycle_version = lifecycle_version + 1,
      updated_at = now()
  where connection_id = p_connection_id
    and user_id = p_user_id
    and lifecycle_state = p_expected_state
    and lifecycle_version = p_expected_version;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then return false; end if;

  update public.composio_connections
  set status = p_public_status,
      remote_verified_at = p_remote_verified_at,
      verification_error_code = p_verification_error_code,
      lifecycle_version = lifecycle_version + 1,
      updated_at = now()
  where id = p_connection_id and user_id = p_user_id;
  if not found then
    raise exception 'public connection disappeared during authority transition';
  end if;
  return true;
end;
$$;

create or replace function public.axis_promote_composio_connection_authority(
  p_connection_id uuid,
  p_user_id uuid,
  p_toolkit text,
  p_expected_version bigint,
  p_remote_verified_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_toolkit not in ('gmail', 'outlook', 'googlecalendar', 'googlecontacts', 'strava', 'spotify')
    or p_remote_verified_at is null or p_remote_verified_at > now() + interval '1 minute'
    or p_remote_verified_at < now() - interval '10 minutes' then
    raise exception 'authority proof timestamp is invalid' using errcode = '22023';
  end if;
  -- Acquire same-owner/toolkit rows in a stable order before changing either
  -- lifecycle. The caller has already performed the exact remote proof.
  perform 1 from public.composio_connection_authorities
  where user_id = p_user_id and toolkit = p_toolkit
  order by connection_id for update;

  -- Validate the new attempt before disturbing a healthy active authority.
  perform 1 from public.composio_connection_authorities
  where connection_id = p_connection_id and user_id = p_user_id and toolkit = p_toolkit
    and lifecycle_state = 'INITIATED' and lifecycle_version = p_expected_version
  for update;
  if not found then return false; end if;

  update public.composio_connection_authorities
  set lifecycle_state = 'SUPERSEDED', remote_verified_at = null,
      last_observation = 'RECONNECT_REQUIRED', observed_at = now(),
      lifecycle_version = lifecycle_version + 1, updated_at = now()
  where user_id = p_user_id and toolkit = p_toolkit and connection_id <> p_connection_id
    and lifecycle_state = 'ACTIVE' and p_toolkit not in ('gmail', 'outlook');

  update public.composio_connection_authorities
  set lifecycle_state = 'ACTIVE', remote_verified_at = p_remote_verified_at,
      last_observation = 'ACTIVE', observed_at = now(),
      lifecycle_version = lifecycle_version + 1, updated_at = now()
  where connection_id = p_connection_id and user_id = p_user_id and toolkit = p_toolkit
    and lifecycle_state = 'INITIATED' and lifecycle_version = p_expected_version;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then raise exception 'promotion target changed after lock'; end if;

  update public.composio_connections
  set status = 'UNVERIFIED', remote_verified_at = null,
      verification_error_code = 'superseded', lifecycle_version = lifecycle_version + 1, updated_at = now()
  where user_id = p_user_id and toolkit = p_toolkit and id <> p_connection_id
    and status = 'ACTIVE' and p_toolkit not in ('gmail', 'outlook');

  update public.composio_connections
  set status = 'ACTIVE', remote_verified_at = p_remote_verified_at,
      verification_error_code = null, lifecycle_version = lifecycle_version + 1, updated_at = now()
  where id = p_connection_id and user_id = p_user_id;
  if not found then raise exception 'public connection disappeared during authority promotion'; end if;
  return true;
end;
$$;

create or replace function public.axis_adopt_composio_connection_authority(
  p_connection_id uuid,
  p_user_id uuid,
  p_toolkit text,
  p_connected_account_id text,
  p_auth_config_id text,
  p_remote_verified_at timestamptz,
  p_public_status text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_toolkit not in ('gmail', 'outlook', 'googlecalendar', 'googlecontacts', 'strava', 'spotify')
    or p_connected_account_id is null or length(p_connected_account_id) not between 1 and 256
    or p_auth_config_id is null or length(p_auth_config_id) not between 1 and 256
    or p_public_status <> 'ACTIVE' or p_remote_verified_at is null
    or p_remote_verified_at > now() + interval '1 minute'
    or p_remote_verified_at < now() - interval '10 minutes' then
    raise exception 'legacy adoption requires a fresh active proof' using errcode = '22023';
  end if;
  -- Bind exactly the pre-existing local row; arbitrary caller-supplied values
  -- cannot mint membership for a different owner/toolkit/account/config.
  if not exists (
    select 1 from public.composio_connections
    where id = p_connection_id and user_id = p_user_id and toolkit = p_toolkit
      and connected_account_id = p_connected_account_id and auth_config_id = p_auth_config_id
  ) then return false; end if;

  insert into public.composio_connection_authorities (
    connection_id, user_id, toolkit, connected_account_id, auth_config_id,
    lifecycle_state, remote_verified_at, last_observation, observed_at
  ) values (
    p_connection_id, p_user_id, p_toolkit, p_connected_account_id, p_auth_config_id,
    case when p_public_status = 'ACTIVE' then 'ACTIVE' else 'INITIATED' end,
    p_remote_verified_at,
    case when p_public_status = 'ACTIVE' then 'ACTIVE' else 'RECONNECT_REQUIRED' end,
    now()
  ) on conflict (connection_id) do nothing;
  if not found then return false; end if;

  update public.composio_connections
  set status = p_public_status, remote_verified_at = p_remote_verified_at,
      verification_error_code = null, lifecycle_version = lifecycle_version + 1, updated_at = now()
  where id = p_connection_id and user_id = p_user_id;
  if not found then
    raise exception 'public connection disappeared during authority adoption';
  end if;
  return true;
end;
$$;

revoke all on function public.axis_create_composio_connection_authority(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.axis_transition_composio_connection_authority(uuid, uuid, text, bigint, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.axis_adopt_composio_connection_authority(uuid, uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.axis_promote_composio_connection_authority(uuid, uuid, text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.axis_create_composio_connection_authority(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.axis_transition_composio_connection_authority(uuid, uuid, text, bigint, text, timestamptz, text, text) to service_role;
grant execute on function public.axis_adopt_composio_connection_authority(uuid, uuid, text, text, text, timestamptz, text) to service_role;
grant execute on function public.axis_promote_composio_connection_authority(uuid, uuid, text, bigint, timestamptz) to service_role;

commit;
