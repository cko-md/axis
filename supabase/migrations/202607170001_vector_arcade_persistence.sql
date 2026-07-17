-- Wave 15.2: VECTOR offline-first cloud persistence.
-- Browser clients may read only their own rows. Every mutation is performed by
-- authenticated server routes through service-role-only, atomic RPCs.

begin;

create table public.game_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  profile_version integer not null default 1 check (profile_version between 1 and 10000),
  server_revision bigint not null default 0
    check (server_revision between 0 and 9007199254740991),
  settings jsonb not null default '{}'::jsonb,
  setting_clocks jsonb not null default '{}'::jsonb,
  unlocks text[] not null default '{}',
  counters jsonb not null default '{}'::jsonb,
  last_device_id text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint game_profiles_documents_check check (
    jsonb_typeof(settings) = 'object'
    and jsonb_typeof(setting_clocks) = 'object'
    and jsonb_typeof(counters) = 'object'
    -- PostgreSQL's jsonb text form is slightly more verbose than the canonical
    -- client encoding, so this defense is intentionally conservative at the
    -- shared 16 KiB document contract.
    and octet_length(settings::text) <= 16384
    and octet_length(setting_clocks::text) <= 16384
    and octet_length(counters::text) <= 16384
    and coalesce(cardinality(unlocks), 0) <= 256
  ),
  constraint game_profiles_device_check check (
    last_device_id is null
    or (
      char_length(last_device_id) between 8 and 128
      and last_device_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
  )
);

create table public.game_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null check (game_id in (
    'second-sense', 'brickrise', 'time-to-fly', 'paper-glider',
    'envoy-arena', 'phantasy-axis', 'biome-lab', 'mini-town', 'neon-rift'
  )),
  idempotency_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  device_id text not null check (
    char_length(device_id) between 8 and 128
    and device_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  client_revision bigint not null
    check (client_revision between 1 and 9007199254740991),
  event_kind text not null check (event_kind in (
    'save', 'score', 'achievement', 'counter', 'settings', 'conflict_resolution'
  )),
  request_payload jsonb not null default '{}'::jsonb
    check (octet_length(request_payload::text) <= 8192),
  status text not null default 'processing'
    check (status in ('processing', 'applied', 'conflict', 'rejected')),
  outcome jsonb check (outcome is null or octet_length(outcome::text) <= 16384),
  occurred_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (user_id, idempotency_key)
);

create table public.game_saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null check (game_id in (
    'second-sense', 'brickrise', 'time-to-fly', 'paper-glider',
    'envoy-arena', 'phantasy-axis', 'biome-lab', 'mini-town', 'neon-rift'
  )),
  slot_id text not null check (
    char_length(slot_id) between 1 and 64
    and slot_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  game_version text not null check (
    char_length(game_version) between 1 and 32
    and game_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]*$'
  ),
  save_schema_version integer not null check (save_schema_version between 1 and 10000),
  server_revision bigint not null
    check (server_revision between 1 and 9007199254740991),
  client_revision bigint not null
    check (client_revision between 1 and 9007199254740991),
  device_id text not null check (
    char_length(device_id) between 8 and 128
    and device_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  seed text check (seed is null or char_length(seed) <= 256),
  -- The API enforces 128 KiB of canonical JSON. jsonb::text may add whitespace.
  state jsonb not null check (octet_length(state::text) <= 262144),
  source_event_id uuid not null references public.game_events (id),
  client_updated_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  deleted_at timestamptz,
  unique (user_id, game_id, slot_id)
);

create table public.game_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null check (game_id in (
    'second-sense', 'brickrise', 'time-to-fly', 'paper-glider',
    'envoy-arena', 'phantasy-axis', 'biome-lab', 'mini-town', 'neon-rift'
  )),
  mode text not null check (
    char_length(mode) between 1 and 64
    and mode ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  challenge_id text check (
    challenge_id is null
    or (
      char_length(challenge_id) between 1 and 64
      and challenge_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
  ),
  challenge_key text not null,
  score bigint not null check (score between 0 and 9007199254740991),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'rejected')),
  source_event_id uuid not null references public.game_events (id),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint game_scores_challenge_key_check
    check (challenge_key = coalesce(challenge_id, '')),
  unique (user_id, game_id, mode, challenge_key)
);

create table public.game_achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null check (game_id in (
    'second-sense', 'brickrise', 'time-to-fly', 'paper-glider',
    'envoy-arena', 'phantasy-axis', 'biome-lab', 'mini-town', 'neon-rift'
  )),
  achievement_id text not null check (
    char_length(achievement_id) between 1 and 96
    and achievement_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  source_event_id uuid not null references public.game_events (id),
  unlocked_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (user_id, game_id, achievement_id)
);

create table public.game_save_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null check (game_id in (
    'second-sense', 'brickrise', 'time-to-fly', 'paper-glider',
    'envoy-arena', 'phantasy-axis', 'biome-lab', 'mini-town', 'neon-rift'
  )),
  slot_id text not null check (
    char_length(slot_id) between 1 and 64
    and slot_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  reason text not null check (reason in (
    'revision_mismatch', 'server_missing', 'local_checksum_mismatch',
    'anonymous_adoption_collision'
  )),
  conflict_version bigint not null default 1
    check (conflict_version between 1 and 9007199254740991),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text check (resolution in ('accept-local', 'accept-server', 'fork-local')),
  source_event_id uuid not null unique references public.game_events (id),
  resolved_event_id uuid unique references public.game_events (id),
  local_revision bigint not null
    check (local_revision between 1 and 9007199254740991),
  local_device_id text not null check (
    char_length(local_device_id) between 8 and 128
    and local_device_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  local_game_version text not null check (
    char_length(local_game_version) between 1 and 32
    and local_game_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]*$'
  ),
  local_save_schema_version integer not null
    check (local_save_schema_version between 1 and 10000),
  local_checksum text not null check (local_checksum ~ '^[0-9a-f]{64}$'),
  local_seed text check (local_seed is null or char_length(local_seed) <= 256),
  local_state jsonb not null check (octet_length(local_state::text) <= 262144),
  local_updated_at timestamptz not null,
  server_revision bigint not null default 0
    check (server_revision between 0 and 9007199254740991),
  server_game_version text check (
    server_game_version is null
    or (
      char_length(server_game_version) between 1 and 32
      and server_game_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]*$'
    )
  ),
  server_save_schema_version integer
    check (server_save_schema_version is null or server_save_schema_version between 1 and 10000),
  server_checksum text check (server_checksum is null or server_checksum ~ '^[0-9a-f]{64}$'),
  server_seed text check (server_seed is null or char_length(server_seed) <= 256),
  server_state jsonb check (
    server_state is null or octet_length(server_state::text) <= 262144
  ),
  server_updated_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  constraint game_save_conflicts_resolution_state_check check (
    (
      status = 'open'
      and resolution is null
      and resolved_event_id is null
      and resolved_at is null
    )
    or
    (
      status = 'resolved'
      and resolution is not null
      and resolved_event_id is not null
      and resolved_at is not null
    )
  ),
  constraint game_save_conflicts_server_branch_check check (
    (
      server_revision = 0
      and server_game_version is null
      and server_save_schema_version is null
      and server_checksum is null
      and server_seed is null
      and server_state is null
      and server_updated_at is null
    )
    or
    (
      server_revision > 0
      and server_game_version is not null
      and server_save_schema_version is not null
      and server_checksum is not null
      and server_state is not null
      and server_updated_at is not null
    )
  )
);

create index game_saves_owner_updated_idx
  on public.game_saves (user_id, game_id, updated_at desc)
  where deleted_at is null;
create index game_events_owner_created_idx
  on public.game_events (user_id, game_id, created_at desc);
create index game_scores_owner_updated_idx
  on public.game_scores (user_id, game_id, updated_at desc);
create index game_achievements_owner_unlocked_idx
  on public.game_achievements (user_id, game_id, unlocked_at desc);
create index game_save_conflicts_owner_status_idx
  on public.game_save_conflicts (user_id, game_id, status, created_at desc);

create unique index game_save_conflicts_one_open_slot_idx
  on public.game_save_conflicts (user_id, game_id, slot_id)
  where status = 'open';

alter table public.game_profiles enable row level security;
alter table public.game_saves enable row level security;
alter table public.game_events enable row level security;
alter table public.game_scores enable row level security;
alter table public.game_achievements enable row level security;
alter table public.game_save_conflicts enable row level security;

create policy "game_profiles_select_own"
  on public.game_profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "game_saves_select_own"
  on public.game_saves for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "game_events_select_own"
  on public.game_events for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "game_scores_select_own"
  on public.game_scores for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "game_achievements_select_own"
  on public.game_achievements for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "game_save_conflicts_select_own"
  on public.game_save_conflicts for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table
  public.game_profiles,
  public.game_saves,
  public.game_events,
  public.game_scores,
  public.game_achievements,
  public.game_save_conflicts
from public, anon, authenticated;
grant select on table
  public.game_profiles,
  public.game_saves,
  public.game_events,
  public.game_scores,
  public.game_achievements,
  public.game_save_conflicts
to authenticated;
grant all on table
  public.game_profiles,
  public.game_saves,
  public.game_events,
  public.game_scores,
  public.game_achievements,
  public.game_save_conflicts
to service_role;

create or replace function public.sync_vector_save(
  p_user_id uuid,
  p_game_id text,
  p_device_id text,
  p_idempotency_key uuid,
  p_payload_hash text,
  p_slot_id text,
  p_game_version text,
  p_save_schema_version integer,
  p_expected_server_revision bigint,
  p_client_revision bigint,
  p_checksum text,
  p_seed text,
  p_state jsonb,
  p_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.game_events%rowtype;
  v_existing_event public.game_events%rowtype;
  v_save public.game_saves%rowtype;
  v_conflict public.game_save_conflicts%rowtype;
  v_open_conflict_id uuid;
  v_save_found boolean;
  v_result jsonb;
  v_next_revision bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_game_id, 0)
  );
  insert into public.game_events (
    user_id, game_id, idempotency_key, payload_hash, device_id,
    client_revision, event_kind, request_payload, occurred_at
  ) values (
    p_user_id, p_game_id, p_idempotency_key, p_payload_hash, p_device_id,
    p_client_revision, 'save',
    jsonb_build_object(
      'slot_id', p_slot_id,
      'expected_server_revision', p_expected_server_revision,
      'client_revision', p_client_revision,
      'checksum', p_checksum
    ),
    p_updated_at
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_event;

  if not found then
    select * into v_existing_event
    from public.game_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_existing_event.payload_hash is distinct from p_payload_hash
       or v_existing_event.game_id is distinct from p_game_id
       or v_existing_event.event_kind is distinct from 'save' then
      return jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'rejected', 'code', 'VECTOR_IDEMPOTENCY_REUSED',
        'slotId', p_slot_id, 'localRevision', p_client_revision,
        'serverRevision', null, 'conflictId', null
      );
    end if;
    if v_existing_event.outcome is null then
      return jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'rejected', 'code', 'VECTOR_IDEMPOTENCY_INCOMPLETE',
        'slotId', p_slot_id, 'localRevision', p_client_revision,
        'serverRevision', null, 'conflictId', null
      );
    end if;
    if v_existing_event.outcome->>'status' = 'applied' then
      return v_existing_event.outcome || jsonb_build_object('status', 'duplicate', 'code', null);
    end if;
    return v_existing_event.outcome;
  end if;

  select * into v_save
  from public.game_saves
  where user_id = p_user_id
    and game_id = p_game_id
    and slot_id = p_slot_id
    and deleted_at is null
  for update;
  v_save_found := found;

  select id into v_open_conflict_id
  from public.game_save_conflicts
  where user_id = p_user_id
    and game_id = p_game_id
    and slot_id = p_slot_id
    and status = 'open'
  order by created_at
  limit 1
  for update;

  if v_open_conflict_id is not null and not (
    v_save_found
    and v_save.checksum = p_checksum
    and v_save.game_version = p_game_version
    and v_save.save_schema_version = p_save_schema_version
    and v_save.seed is not distinct from p_seed
  ) then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'conflict', 'code', 'VECTOR_SAVE_CONFLICT_OPEN',
      'slotId', p_slot_id, 'localRevision', p_client_revision,
      'serverRevision', coalesce(v_save.server_revision, 0),
      'conflictId', v_open_conflict_id
    );
  elsif v_save_found
     and v_save.checksum = p_checksum
     and v_save.game_version = p_game_version
     and v_save.save_schema_version = p_save_schema_version
     and v_save.seed is not distinct from p_seed then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'applied', 'code', null,
      'slotId', p_slot_id, 'localRevision', p_client_revision,
      'serverRevision', v_save.server_revision, 'conflictId', null
    );
  elsif (v_save_found and v_save.server_revision <> p_expected_server_revision)
     or (not v_save_found and p_expected_server_revision <> 0) then
    insert into public.game_save_conflicts (
      user_id, game_id, slot_id, reason, source_event_id,
      local_revision, local_device_id, local_game_version,
      local_save_schema_version, local_checksum, local_seed, local_state,
      local_updated_at, server_revision, server_game_version,
      server_save_schema_version, server_checksum, server_seed, server_state,
      server_updated_at
    ) values (
      p_user_id, p_game_id, p_slot_id,
      case when not v_save_found then 'server_missing' else 'revision_mismatch' end,
      v_event.id, p_client_revision, p_device_id, p_game_version,
      p_save_schema_version, p_checksum, p_seed, p_state, p_updated_at,
      coalesce(v_save.server_revision, 0), v_save.game_version,
      v_save.save_schema_version, v_save.checksum, v_save.seed, v_save.state,
      v_save.updated_at
    )
    returning * into v_conflict;
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'conflict', 'code', 'VECTOR_SAVE_CONFLICT',
      'slotId', p_slot_id, 'localRevision', p_client_revision,
      'serverRevision', coalesce(v_save.server_revision, 0),
      'conflictId', v_conflict.id
    );
  else
    if not v_save_found and (
      select count(*) from public.game_saves
      where user_id = p_user_id and game_id = p_game_id and deleted_at is null
    ) >= 8 then
      v_result := jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'rejected', 'code', 'VECTOR_SAVE_SLOT_LIMIT',
        'slotId', p_slot_id, 'localRevision', p_client_revision,
        'serverRevision', null, 'conflictId', null
      );
    else
      v_next_revision := coalesce(v_save.server_revision, 0) + 1;
      insert into public.game_saves (
        user_id, game_id, slot_id, game_version, save_schema_version,
        server_revision, client_revision, device_id, checksum, seed, state,
        source_event_id, client_updated_at, updated_at, deleted_at
      ) values (
        p_user_id, p_game_id, p_slot_id, p_game_version, p_save_schema_version,
        v_next_revision, p_client_revision, p_device_id, p_checksum, p_seed, p_state,
        v_event.id, p_updated_at, statement_timestamp(), null
      )
      on conflict (user_id, game_id, slot_id) do update set
        game_version = excluded.game_version,
        save_schema_version = excluded.save_schema_version,
        server_revision = excluded.server_revision,
        client_revision = excluded.client_revision,
        device_id = excluded.device_id,
        checksum = excluded.checksum,
        seed = excluded.seed,
        state = excluded.state,
        source_event_id = excluded.source_event_id,
        client_updated_at = excluded.client_updated_at,
        updated_at = statement_timestamp(),
        deleted_at = null;
      insert into public.game_profiles (user_id, server_revision, last_device_id)
      values (p_user_id, 1, p_device_id)
      on conflict (user_id) do update set
        server_revision = public.game_profiles.server_revision + 1,
        last_device_id = excluded.last_device_id,
        updated_at = statement_timestamp();
      v_result := jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'applied', 'code', null,
        'slotId', p_slot_id, 'localRevision', p_client_revision,
        'serverRevision', v_next_revision, 'conflictId', null
      );
    end if;
  end if;

  update public.game_events
  set
    status = case v_result->>'status'
      when 'conflict' then 'conflict'
      when 'rejected' then 'rejected'
      else 'applied'
    end,
    outcome = v_result,
    updated_at = statement_timestamp()
  where id = v_event.id;
  return v_result;
end;
$$;

create or replace function public.apply_vector_event(
  p_user_id uuid,
  p_game_id text,
  p_device_id text,
  p_idempotency_key uuid,
  p_payload_hash text,
  p_client_revision bigint,
  p_event_kind text,
  p_payload jsonb,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.game_events%rowtype;
  v_existing_event public.game_events%rowtype;
  v_profile public.game_profiles%rowtype;
  v_result jsonb;
  v_key text;
  v_score bigint;
  v_delta bigint;
  v_current bigint;
  v_previous_counter bigint;
  v_values jsonb;
  v_clocks jsonb;
  v_incoming_clock jsonb;
  v_current_clock jsonb;
  v_incoming_at timestamptz;
  v_current_at timestamptz;
  v_incoming_device text;
  v_current_device text;
  v_profile_revision bigint;
begin
  if p_event_kind not in ('score', 'achievement', 'counter', 'settings') then
    raise exception 'invalid vector event kind' using errcode = '22023';
  end if;
  insert into public.game_events (
    user_id, game_id, idempotency_key, payload_hash, device_id,
    client_revision, event_kind, request_payload, occurred_at
  ) values (
    p_user_id, p_game_id, p_idempotency_key, p_payload_hash, p_device_id,
    p_client_revision, p_event_kind, p_payload, p_occurred_at
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_event;

  if not found then
    select * into v_existing_event
    from public.game_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_existing_event.payload_hash is distinct from p_payload_hash
       or v_existing_event.game_id is distinct from p_game_id
       or v_existing_event.event_kind is distinct from p_event_kind then
      return jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', p_event_kind,
        'status', 'rejected', 'code', 'VECTOR_IDEMPOTENCY_REUSED',
        'slotId', null, 'localRevision', p_client_revision,
        'serverRevision', null, 'conflictId', null
      );
    end if;
    if v_existing_event.outcome is null then
      return jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', p_event_kind,
        'status', 'rejected', 'code', 'VECTOR_IDEMPOTENCY_INCOMPLETE',
        'slotId', null, 'localRevision', p_client_revision,
        'serverRevision', null, 'conflictId', null
      );
    end if;
    if v_existing_event.outcome->>'status' = 'applied' then
      return v_existing_event.outcome || jsonb_build_object('status', 'duplicate', 'code', null);
    end if;
    return v_existing_event.outcome;
  end if;

  if p_event_kind = 'settings' and exists (
    select 1
    from jsonb_each(p_payload->'clocks') as clock_entry
    where (clock_entry.value->>'at')::timestamptz
      > statement_timestamp() + interval '5 minutes'
  ) then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', p_event_kind,
      'status', 'rejected', 'code', 'VECTOR_SETTING_CLOCK_FUTURE',
      'slotId', null, 'localRevision', p_client_revision,
      'serverRevision', null, 'conflictId', null
    );
    update public.game_events
    set status = 'rejected', outcome = v_result, updated_at = statement_timestamp()
    where id = v_event.id;
    return v_result;
  end if;

  insert into public.game_profiles (user_id, last_device_id)
  values (p_user_id, p_device_id)
  on conflict (user_id) do nothing;
  select * into v_profile
  from public.game_profiles
  where user_id = p_user_id
  for update;

  if p_event_kind = 'score' then
    v_score := (p_payload->>'value')::bigint;
    if v_score < 0 or v_score > 9007199254740991 then
      raise exception 'invalid score' using errcode = '22023';
    end if;
    insert into public.game_scores (
      user_id, game_id, mode, challenge_id, challenge_key, score,
      verification_status, source_event_id
    ) values (
      p_user_id, p_game_id, p_payload->>'mode',
      nullif(p_payload->>'challengeId', ''),
      coalesce(nullif(p_payload->>'challengeId', ''), ''),
      v_score, 'unverified', v_event.id
    )
    on conflict (user_id, game_id, mode, challenge_key) do update set
      score = greatest(public.game_scores.score, excluded.score),
      source_event_id = case
        when excluded.score > public.game_scores.score then excluded.source_event_id
        else public.game_scores.source_event_id
      end,
      updated_at = statement_timestamp();
  elsif p_event_kind = 'achievement' then
    insert into public.game_achievements (
      user_id, game_id, achievement_id, source_event_id, unlocked_at
    ) values (
      p_user_id, p_game_id, p_payload->>'achievementId', v_event.id, p_occurred_at
    )
    on conflict (user_id, game_id, achievement_id) do nothing;
  elsif p_event_kind = 'counter' then
    v_key := p_game_id || ':' || (p_payload->>'counterId');
    v_delta := (p_payload->>'delta')::bigint;
    if v_delta < 1 or v_delta > 1000000 then
      raise exception 'invalid counter delta' using errcode = '22023';
    end if;
    v_current := coalesce((v_profile.counters->>v_key)::bigint, 0);
    v_previous_counter := v_current;
    if v_current + v_delta > 9007199254740991 then
      v_result := jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', p_event_kind,
        'status', 'rejected', 'code', 'VECTOR_COUNTER_OVERFLOW',
        'slotId', null, 'localRevision', p_client_revision,
        'serverRevision', v_profile.server_revision,
        'conflictId', null, 'authoritativeValue', v_current
      );
      update public.game_events
      set status = 'rejected', outcome = v_result, updated_at = statement_timestamp()
      where id = v_event.id;
      return v_result;
    end if;
    v_current := v_current + v_delta;
    v_profile.counters := jsonb_set(
      v_profile.counters, array[v_key], to_jsonb(v_current), true
    );
  else
    v_values := p_payload->'values';
    v_clocks := p_payload->'clocks';
    if jsonb_typeof(v_values) <> 'object'
       or jsonb_typeof(v_clocks) <> 'object'
       or (select count(*) from jsonb_object_keys(v_values)) > 32
       or (select count(*) from jsonb_object_keys(v_values))
          <> (select count(*) from jsonb_object_keys(v_clocks)) then
      raise exception 'invalid settings payload' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(v_values)
    loop
      v_incoming_clock := v_clocks->v_key;
      if v_incoming_clock is null then
        raise exception 'missing setting clock' using errcode = '22023';
      end if;
      v_current_clock := v_profile.setting_clocks->v_key;
      v_incoming_at := (v_incoming_clock->>'at')::timestamptz;
      v_incoming_device := v_incoming_clock->>'deviceId';
      if v_current_clock is null then
        v_profile.settings := jsonb_set(
          v_profile.settings, array[v_key], v_values->v_key, true
        );
        v_profile.setting_clocks := jsonb_set(
          v_profile.setting_clocks, array[v_key], v_incoming_clock, true
        );
      else
        v_current_at := (v_current_clock->>'at')::timestamptz;
        v_current_device := v_current_clock->>'deviceId';
        if v_incoming_at > v_current_at
           or (
             v_incoming_at = v_current_at
             and v_incoming_device collate "C" > v_current_device collate "C"
           ) then
          v_profile.settings := jsonb_set(
            v_profile.settings, array[v_key], v_values->v_key, true
          );
          v_profile.setting_clocks := jsonb_set(
            v_profile.setting_clocks, array[v_key], v_incoming_clock, true
          );
        end if;
      end if;
    end loop;
  end if;

  if octet_length(v_profile.settings::text) > 16384
     or octet_length(v_profile.setting_clocks::text) > 16384
     or octet_length(v_profile.counters::text) > 16384 then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', p_event_kind,
      'status', 'rejected', 'code', 'VECTOR_PROFILE_TOO_LARGE',
      'slotId', null, 'localRevision', p_client_revision,
      'serverRevision', v_profile.server_revision, 'conflictId', null
    );
    if p_event_kind = 'counter' then
      v_result := v_result || jsonb_build_object(
        'authoritativeValue', v_previous_counter
      );
    end if;
    update public.game_events
    set status = 'rejected', outcome = v_result, updated_at = statement_timestamp()
    where id = v_event.id;
    return v_result;
  end if;

  update public.game_profiles
  set
    settings = v_profile.settings,
    setting_clocks = v_profile.setting_clocks,
    counters = v_profile.counters,
    server_revision = server_revision + 1,
    last_device_id = p_device_id,
    updated_at = statement_timestamp()
  where user_id = p_user_id
  returning server_revision into v_profile_revision;

  v_result := jsonb_build_object(
    'idempotencyKey', p_idempotency_key, 'kind', p_event_kind,
    'status', 'applied', 'code', null,
    'slotId', null, 'localRevision', p_client_revision,
    'serverRevision', v_profile_revision, 'conflictId', null
  );
  if p_event_kind = 'counter' then
    v_result := v_result || jsonb_build_object(
      'authoritativeValue', v_current
    );
  end if;
  update public.game_events
  set status = 'applied', outcome = v_result, updated_at = statement_timestamp()
  where id = v_event.id;
  return v_result;
end;
$$;

create or replace function public.resolve_vector_conflict(
  p_user_id uuid,
  p_conflict_id uuid,
  p_idempotency_key uuid,
  p_payload_hash text,
  p_expected_conflict_version bigint,
  p_resolution text,
  p_target_slot_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_conflict public.game_save_conflicts%rowtype;
  v_event public.game_events%rowtype;
  v_existing_event public.game_events%rowtype;
  v_save public.game_saves%rowtype;
  v_result jsonb;
  v_slot_id text;
  v_server_revision bigint;
  v_game_id text;
  v_resolved_branch jsonb;
begin
  select game_id into v_game_id
  from public.game_save_conflicts
  where id = p_conflict_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'rejected', 'code', 'VECTOR_CONFLICT_NOT_FOUND',
      'slotId', null, 'localRevision', null,
      'serverRevision', null, 'conflictId', p_conflict_id
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_game_id, 0)
  );
  select * into v_conflict
  from public.game_save_conflicts
  where id = p_conflict_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'rejected', 'code', 'VECTOR_CONFLICT_NOT_FOUND',
      'slotId', null, 'localRevision', null,
      'serverRevision', null, 'conflictId', p_conflict_id
    );
  end if;

  insert into public.game_events (
    user_id, game_id, idempotency_key, payload_hash, device_id,
    client_revision, event_kind, request_payload, occurred_at
  ) values (
    p_user_id, v_conflict.game_id, p_idempotency_key, p_payload_hash,
    v_conflict.local_device_id, v_conflict.local_revision,
    'conflict_resolution',
    jsonb_build_object(
      'conflict_id', p_conflict_id,
      'expected_conflict_version', p_expected_conflict_version,
      'resolution', p_resolution,
      'target_slot_id', p_target_slot_id
    ),
    statement_timestamp()
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_event;

  if not found then
    select * into v_existing_event
    from public.game_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_existing_event.payload_hash is distinct from p_payload_hash
       or v_existing_event.game_id is distinct from v_conflict.game_id
       or v_existing_event.event_kind is distinct from 'conflict_resolution' then
      return jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'rejected', 'code', 'VECTOR_IDEMPOTENCY_REUSED',
        'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
        'serverRevision', v_conflict.server_revision, 'conflictId', p_conflict_id
      );
    end if;
    if v_existing_event.outcome is null then
      return jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'rejected', 'code', 'VECTOR_IDEMPOTENCY_INCOMPLETE',
        'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
        'serverRevision', v_conflict.server_revision, 'conflictId', p_conflict_id
      );
    end if;
    if v_existing_event.outcome->>'status' = 'applied' then
      return v_existing_event.outcome || jsonb_build_object('status', 'duplicate', 'code', null);
    end if;
    return v_existing_event.outcome;
  end if;

  if v_conflict.status <> 'open' then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'rejected', 'code', 'VECTOR_CONFLICT_ALREADY_RESOLVED',
      'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
      'serverRevision', v_conflict.server_revision, 'conflictId', p_conflict_id
    );
  elsif v_conflict.conflict_version <> p_expected_conflict_version then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'rejected', 'code', 'VECTOR_CONFLICT_VERSION_MISMATCH',
      'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
      'serverRevision', v_conflict.server_revision, 'conflictId', p_conflict_id
    );
  elsif p_resolution is null
     or p_resolution not in ('accept-local', 'accept-server', 'fork-local') then
    v_result := jsonb_build_object(
      'idempotencyKey', p_idempotency_key, 'kind', 'save',
      'status', 'rejected', 'code', 'VECTOR_CONFLICT_RESOLUTION_INVALID',
      'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
      'serverRevision', v_conflict.server_revision, 'conflictId', p_conflict_id
    );
  else
    select * into v_save
    from public.game_saves
    where user_id = p_user_id
      and game_id = v_conflict.game_id
      and slot_id = v_conflict.slot_id
      and deleted_at is null
    for update;

    if p_resolution = 'accept-local' then
      if (v_conflict.server_revision = 0 and v_save.id is not null)
         or (v_conflict.server_revision > 0 and (
           v_save.id is null
           or v_save.server_revision <> v_conflict.server_revision
           or v_save.checksum is distinct from v_conflict.server_checksum
         )) then
        v_result := jsonb_build_object(
          'idempotencyKey', p_idempotency_key, 'kind', 'save',
          'status', 'rejected', 'code', 'VECTOR_CONFLICT_STALE',
          'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
          'serverRevision', coalesce(v_save.server_revision, 0),
          'conflictId', p_conflict_id
        );
      elsif v_save.id is null and (
        select count(*) from public.game_saves
        where user_id = p_user_id
          and game_id = v_conflict.game_id
          and deleted_at is null
      ) >= 8 then
        v_result := jsonb_build_object(
          'idempotencyKey', p_idempotency_key, 'kind', 'save',
          'status', 'rejected', 'code', 'VECTOR_SAVE_SLOT_LIMIT',
          'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
          'serverRevision', null, 'conflictId', p_conflict_id
        );
      else
        v_server_revision := coalesce(v_save.server_revision, 0) + 1;
        insert into public.game_saves (
          user_id, game_id, slot_id, game_version, save_schema_version,
          server_revision, client_revision, device_id, checksum, seed, state,
          source_event_id, client_updated_at, updated_at, deleted_at
        ) values (
          p_user_id, v_conflict.game_id, v_conflict.slot_id,
          v_conflict.local_game_version, v_conflict.local_save_schema_version,
          v_server_revision, v_conflict.local_revision, v_conflict.local_device_id,
          v_conflict.local_checksum, v_conflict.local_seed, v_conflict.local_state,
          v_event.id, v_conflict.local_updated_at, statement_timestamp(), null
        )
        on conflict (user_id, game_id, slot_id) do update set
          game_version = excluded.game_version,
          save_schema_version = excluded.save_schema_version,
          server_revision = excluded.server_revision,
          client_revision = excluded.client_revision,
          device_id = excluded.device_id,
          checksum = excluded.checksum,
          seed = excluded.seed,
          state = excluded.state,
          source_event_id = excluded.source_event_id,
          client_updated_at = excluded.client_updated_at,
          updated_at = statement_timestamp(),
          deleted_at = null;
        v_slot_id := v_conflict.slot_id;
      end if;
    elsif p_resolution = 'accept-server' then
      if (v_conflict.server_revision = 0 and v_save.id is not null)
         or (v_conflict.server_revision > 0 and (
           v_save.id is null
           or v_save.server_revision <> v_conflict.server_revision
           or v_save.checksum is distinct from v_conflict.server_checksum
         )) then
        v_result := jsonb_build_object(
          'idempotencyKey', p_idempotency_key, 'kind', 'save',
          'status', 'rejected', 'code', 'VECTOR_CONFLICT_STALE',
          'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
          'serverRevision', coalesce(v_save.server_revision, 0),
          'conflictId', p_conflict_id
        );
      else
        v_server_revision := coalesce(v_save.server_revision, 0);
        v_slot_id := v_conflict.slot_id;
      end if;
    -- Fork intentionally does not require the original slot to match the
    -- previewed server branch: it leaves the current original untouched and
    -- preserves the previewed local branch under the explicit target slot.
    elsif p_resolution = 'fork-local' then
      if p_target_slot_id is null
         or p_target_slot_id = v_conflict.slot_id
         or char_length(p_target_slot_id) not between 1 and 64
         or p_target_slot_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        v_result := jsonb_build_object(
          'idempotencyKey', p_idempotency_key, 'kind', 'save',
          'status', 'rejected', 'code', 'VECTOR_CONFLICT_TARGET_INVALID',
          'slotId', v_conflict.slot_id, 'localRevision', v_conflict.local_revision,
          'serverRevision', v_conflict.server_revision, 'conflictId', p_conflict_id
        );
      elsif exists (
        select 1 from public.game_saves
        where user_id = p_user_id
          and game_id = v_conflict.game_id
          and slot_id = p_target_slot_id
      ) then
        v_result := jsonb_build_object(
          'idempotencyKey', p_idempotency_key, 'kind', 'save',
          'status', 'rejected', 'code', 'VECTOR_CONFLICT_TARGET_EXISTS',
          'slotId', p_target_slot_id, 'localRevision', v_conflict.local_revision,
          'serverRevision', null, 'conflictId', p_conflict_id
        );
      elsif (
        select count(*) from public.game_saves
        where user_id = p_user_id
          and game_id = v_conflict.game_id
          and deleted_at is null
      ) >= 8 then
        v_result := jsonb_build_object(
          'idempotencyKey', p_idempotency_key, 'kind', 'save',
          'status', 'rejected', 'code', 'VECTOR_SAVE_SLOT_LIMIT',
          'slotId', p_target_slot_id, 'localRevision', v_conflict.local_revision,
          'serverRevision', null, 'conflictId', p_conflict_id
        );
      else
        insert into public.game_saves (
          user_id, game_id, slot_id, game_version, save_schema_version,
          server_revision, client_revision, device_id, checksum, seed, state,
          source_event_id, client_updated_at
        ) values (
          p_user_id, v_conflict.game_id, p_target_slot_id,
          v_conflict.local_game_version, v_conflict.local_save_schema_version,
          1, v_conflict.local_revision, v_conflict.local_device_id,
          v_conflict.local_checksum, v_conflict.local_seed, v_conflict.local_state,
          v_event.id, v_conflict.local_updated_at
        );
        v_server_revision := 1;
        v_slot_id := p_target_slot_id;
      end if;
    end if;

    if v_result is null then
      if p_resolution in ('accept-local', 'fork-local') then
        v_resolved_branch := jsonb_build_object(
          'slotId', v_slot_id,
          'deleted', false,
          'serverRevision', v_server_revision,
          'clientRevision', v_conflict.local_revision,
          'gameVersion', v_conflict.local_game_version,
          'saveSchemaVersion', v_conflict.local_save_schema_version,
          'checksum', v_conflict.local_checksum,
          'seed', v_conflict.local_seed
        );
      elsif v_conflict.server_revision = 0 then
        v_resolved_branch := jsonb_build_object(
          'slotId', v_conflict.slot_id,
          'deleted', true,
          'serverRevision', 0,
          'clientRevision', null,
          'gameVersion', null,
          'saveSchemaVersion', null,
          'checksum', null,
          'seed', null
        );
      else
        v_resolved_branch := jsonb_build_object(
          'slotId', v_conflict.slot_id,
          'deleted', false,
          'serverRevision', v_conflict.server_revision,
          'clientRevision', v_save.client_revision,
          'gameVersion', v_conflict.server_game_version,
          'saveSchemaVersion', v_conflict.server_save_schema_version,
          'checksum', v_conflict.server_checksum,
          'seed', v_conflict.server_seed
        );
      end if;
      update public.game_save_conflicts
      set
        status = 'resolved',
        resolution = p_resolution,
        resolved_event_id = v_event.id,
        conflict_version = conflict_version + 1,
        resolved_at = statement_timestamp()
      where id = p_conflict_id;
      insert into public.game_profiles (user_id, server_revision, last_device_id)
      values (p_user_id, 1, v_conflict.local_device_id)
      on conflict (user_id) do update set
        server_revision = public.game_profiles.server_revision + 1,
        last_device_id = excluded.last_device_id,
        updated_at = statement_timestamp();
      v_result := jsonb_build_object(
        'idempotencyKey', p_idempotency_key, 'kind', 'save',
        'status', 'applied', 'code', null,
        'slotId', v_slot_id, 'localRevision', v_conflict.local_revision,
        'serverRevision', v_server_revision, 'conflictId', p_conflict_id,
        'resolvedBranch', v_resolved_branch
      );
    end if;
  end if;

  update public.game_events
  set
    status = case when v_result->>'status' = 'applied' then 'applied' else 'rejected' end,
    outcome = v_result,
    updated_at = statement_timestamp()
  where id = v_event.id;
  return v_result;
end;
$$;

revoke all on function public.sync_vector_save(
  uuid, text, text, uuid, text, text, text, integer, bigint, bigint,
  text, text, jsonb, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.sync_vector_save(
  uuid, text, text, uuid, text, text, text, integer, bigint, bigint,
  text, text, jsonb, timestamptz
) to service_role;

revoke all on function public.apply_vector_event(
  uuid, text, text, uuid, text, bigint, text, jsonb, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.apply_vector_event(
  uuid, text, text, uuid, text, bigint, text, jsonb, timestamptz
) to service_role;

revoke all on function public.resolve_vector_conflict(
  uuid, uuid, uuid, text, bigint, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_vector_conflict(
  uuid, uuid, uuid, text, bigint, text, text
) to service_role;

comment on table public.game_events is
  'Immutable VECTOR idempotency ledger. Payloads are bounded game metadata, never auth credentials or private provider content.';
comment on table public.game_scores is
  'Personal VECTOR scores. Scores remain unverified until a game-specific deterministic verifier exists.';
comment on table public.game_save_conflicts is
  'Preserved local and server save branches; no automatic last-write-wins overwrite.';

commit;
