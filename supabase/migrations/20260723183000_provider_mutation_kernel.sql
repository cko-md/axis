-- Phase 1A expansion: durable provider-mutation command and outcome kernel.
--
-- This is intentionally additive. Provider writes are not replayed from this
-- table: once a command leaves `prepared`, every interruption is an explicit
-- reconciliation problem rather than permission for a blind retry.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.require_service_role()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'provider mutation commands are service-role only'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_service_role() from public, anon, authenticated;
grant execute on function private.require_service_role() to service_role;

create table if not exists public.provider_mutation_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or idempotency_key ~ '^[0-9a-f]{64}$'
  ),
  semantic_hash text not null check (semantic_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('mail_send', 'mail_reply', 'calendar_create', 'calendar_delete', 'composio_disconnect')),
  provider text not null check (provider in ('gmail', 'outlook', 'googlecalendar')),
  transport text not null check (transport = 'composio'),
  connection_ref text not null check (length(connection_ref) between 1 and 512),
  target_resource_id uuid references public.schedule_events(id) on delete restrict,
  external_resource_id text check (external_resource_id is null or length(trim(external_resource_id)) between 1 and 2048),
  deletion_cohort_id uuid,
  deletion_expected_count smallint,
  state text not null default 'prepared' check (state in (
    'prepared', 'dispatching', 'outcome_unknown', 'succeeded',
    'failed_before_dispatch', 'reconciliation_required'
  )),
  version integer not null default 0 check (version >= 0),
  repair_required boolean not null default false,
  last_error_code text check (last_error_code is null or last_error_code in (
    'timeout', 'abort', 'network', 'unknown', 'local_preflight_failed',
    'configuration_unavailable', 'account_unavailable', 'invalid_operation',
    'receipt_persist_failed', 'missing_external_id', 'transition_conflict',
    'post_ack_reconciliation_required', 'confirmed'
  )),
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_mutation_commands_state_timestamps_check check (
    (state = 'prepared' and dispatched_at is null and completed_at is null and repair_required = false)
    or (state = 'dispatching' and dispatched_at is not null and completed_at is null and repair_required = false)
    or (state = 'outcome_unknown' and dispatched_at is not null and completed_at is not null and repair_required = true)
    or (state = 'succeeded' and dispatched_at is not null and completed_at is not null and repair_required = false)
    or (state = 'failed_before_dispatch' and dispatched_at is null and completed_at is not null and repair_required = false)
    or (state = 'reconciliation_required' and dispatched_at is not null and completed_at is not null and repair_required = true)
  ),
  constraint provider_mutation_commands_provider_kind_check check (
    (kind in ('mail_send', 'mail_reply') and provider in ('gmail', 'outlook') and target_resource_id is null)
    or (kind in ('calendar_create', 'calendar_delete') and provider in ('googlecalendar', 'outlook') and target_resource_id is not null)
    or (kind = 'composio_disconnect' and provider in ('gmail', 'outlook', 'googlecalendar') and target_resource_id is null)
  ),
  constraint provider_mutation_commands_delete_target_check check (
    kind <> 'calendar_delete' or (
      external_resource_id is not null and deletion_cohort_id is not null
      and deletion_expected_count between 1 and 2
    )
  ),
  unique (user_id, idempotency_key),
  unique (id, user_id)
);

create table if not exists public.provider_mutation_receipts (
  id uuid primary key default gen_random_uuid(),
  command_id uuid not null,
  user_id uuid not null,
  receipt_kind text not null check (receipt_kind in (
    'provider_acknowledged', 'provider_rejected', 'outcome_unknown',
    'reconciliation_required', 'reconciled'
  )),
  provider_receipt_id text check (provider_receipt_id is null or length(trim(provider_receipt_id)) between 1 and 2048),
  external_resource_id text check (external_resource_id is null or length(trim(external_resource_id)) between 1 and 2048),
  provider_status integer check (provider_status is null or provider_status between 100 and 599),
  error_code text check (error_code is null or error_code in (
    'timeout', 'abort', 'network', 'unknown', 'local_preflight_failed',
    'configuration_unavailable', 'account_unavailable', 'invalid_operation',
    'receipt_persist_failed', 'missing_external_id', 'transition_conflict',
    'post_ack_reconciliation_required', 'confirmed'
  )),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint provider_mutation_receipts_no_raw_payload_check check (
    provider_receipt_id is not null
    or external_resource_id is not null
    or provider_status is not null
    or error_code is not null
  ),
  constraint provider_mutation_receipts_command_owner_fkey
    foreign key (command_id, user_id)
    references public.provider_mutation_commands(id, user_id)
    on delete cascade
);

alter table public.schedule_events
  add column if not exists external_cleanup_state text not null default 'active'
    check (external_cleanup_state in ('active', 'pending', 'reconciliation_required', 'confirmed')),
  add column if not exists deleted_at timestamptz,
  add column if not exists calendar_delete_command_id uuid;

alter table public.schedule_events
  drop constraint if exists schedule_events_calendar_delete_command_id_fkey;
alter table public.schedule_events
  add constraint schedule_events_calendar_delete_command_id_fkey
  foreign key (calendar_delete_command_id)
  references public.provider_mutation_commands(id)
  on delete set null;

-- Expansion preserves mixed-version browser provider-id writes and owner
-- DELETE. It protects only new kernel-owned tombstone metadata; the full
-- provider authority lockdown is deliberately deferred to 20260723183001.
create or replace function public.guard_schedule_event_tombstone_authority()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('request.jwt.claim.role', true) not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.external_cleanup_state <> 'active'
      or new.calendar_delete_command_id is not null then
      raise exception 'calendar deletion authority is server-managed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.deleted_at is distinct from old.deleted_at
    or new.external_cleanup_state is distinct from old.external_cleanup_state
    or new.calendar_delete_command_id is distinct from old.calendar_delete_command_id then
    raise exception 'calendar deletion authority is server-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_events_tombstone_authority_guard on public.schedule_events;
create trigger schedule_events_tombstone_authority_guard
  before insert or update on public.schedule_events
  for each row execute function public.guard_schedule_event_tombstone_authority();
revoke all on function public.guard_schedule_event_tombstone_authority() from public, anon, authenticated;

-- This read policy is compatible with mixed versions (legacy rows default to
-- active) and prevents an expansion-era tombstone from reappearing in the
-- application before the stricter contract grants/policies are installed.
drop policy if exists "schedule_events_select_own" on public.schedule_events;
create policy "schedule_events_select_own"
  on public.schedule_events for select to authenticated
  using ((select auth.uid()) = user_id and deleted_at is null);

create index if not exists provider_mutation_commands_user_state_idx
  on public.provider_mutation_commands(user_id, state, updated_at desc);
create index if not exists provider_mutation_commands_target_idx
  on public.provider_mutation_commands(target_resource_id, state)
  where target_resource_id is not null;
create unique index if not exists provider_mutation_calendar_delete_cohort_provider_idx
  on public.provider_mutation_commands(target_resource_id, provider, deletion_cohort_id)
  where kind = 'calendar_delete';
create index if not exists provider_mutation_receipts_command_idx
  on public.provider_mutation_receipts(command_id, created_at);
create index if not exists schedule_events_visible_idx
  on public.schedule_events(user_id, start_at)
  where deleted_at is null;

alter table public.provider_mutation_commands enable row level security;
alter table public.provider_mutation_receipts enable row level security;

drop policy if exists provider_mutation_commands_select_own on public.provider_mutation_commands;
create policy provider_mutation_commands_select_own
  on public.provider_mutation_commands for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists provider_mutation_receipts_select_own on public.provider_mutation_receipts;
create policy provider_mutation_receipts_select_own
  on public.provider_mutation_receipts for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Browser clients get a stable safe projection, never command internals or
-- receipts. There are deliberately no browser insert/update/delete grants.
revoke all on table public.provider_mutation_commands from anon, authenticated, service_role;
revoke all on table public.provider_mutation_receipts from anon, authenticated, service_role;

create or replace function public.list_provider_mutation_command_status()
returns table (
  id uuid,
  kind text,
  provider text,
  state text,
  version integer,
  repair_required boolean,
  last_error_code text,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    c.id, c.kind, c.provider, c.state, c.version, c.repair_required,
    c.last_error_code, c.dispatched_at, c.completed_at, c.created_at, c.updated_at
  from public.provider_mutation_commands c
  where c.user_id = (select auth.uid())
$$;

revoke all on function public.list_provider_mutation_command_status() from public, anon;
grant execute on function public.list_provider_mutation_command_status() to authenticated;

create or replace view public.provider_mutation_command_status
with (security_barrier = true, security_invoker = true)
as
select status.*
from public.list_provider_mutation_command_status() status
where (select auth.uid()) is not null;

revoke all on public.provider_mutation_command_status from public, anon;
grant select on public.provider_mutation_command_status to authenticated;

create or replace function public.prevent_provider_mutation_receipt_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Receipts are immutable while their owner exists. During an auth.users
  -- erasure cascade, the owner row is already absent when this trigger runs,
  -- so the dependent receipt may be removed with its command.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;
  raise exception 'provider mutation receipts are append-only' using errcode = '55000';
end;
$$;

drop trigger if exists provider_mutation_receipts_append_only on public.provider_mutation_receipts;
create trigger provider_mutation_receipts_append_only
  before update or delete on public.provider_mutation_receipts
  for each row execute function public.prevent_provider_mutation_receipt_change();

revoke all on function public.prevent_provider_mutation_receipt_change() from public, anon, authenticated;

create or replace function public.guard_provider_mutation_command_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.idempotency_key <> old.idempotency_key
    or (new.semantic_hash <> old.semantic_hash and not (
      old.state = 'failed_before_dispatch' and old.dispatched_at is null and new.state = 'prepared'
    )) or new.kind <> old.kind or new.provider <> old.provider
    or new.transport <> old.transport or new.connection_ref is distinct from old.connection_ref
    or new.target_resource_id is distinct from old.target_resource_id
    or new.deletion_cohort_id is distinct from old.deletion_cohort_id
    or new.deletion_expected_count is distinct from old.deletion_expected_count
    or new.created_at <> old.created_at or new.version <> old.version + 1 then
    raise exception 'provider mutation command identity is immutable' using errcode = '55000';
  end if;
  if old.state = 'prepared' and new.state = 'dispatching'
    and old.dispatched_at is null and new.dispatched_at is not null
    and new.completed_at is null and new.repair_required = false then
    return new;
  end if;
  if old.state = 'prepared' and new.state = 'failed_before_dispatch'
    and old.dispatched_at is null and new.dispatched_at is null
    and new.completed_at is not null and new.repair_required = false then
    return new;
  end if;
  if old.state = 'failed_before_dispatch' and new.state = 'prepared'
    and old.dispatched_at is null and new.dispatched_at is null
    and new.completed_at is null and new.repair_required = false then
    return new;
  end if;
  if old.state = 'dispatching' and new.state in ('succeeded', 'outcome_unknown', 'reconciliation_required')
    and old.dispatched_at is not null and new.dispatched_at = old.dispatched_at
    and new.completed_at is not null then
    return new;
  end if;
  if old.state in ('outcome_unknown', 'reconciliation_required')
    and new.state in ('succeeded', 'reconciliation_required')
    and old.dispatched_at is not null and new.dispatched_at = old.dispatched_at
    and new.completed_at is not null then
    return new;
  end if;
  raise exception 'invalid provider mutation command state transition % -> %', old.state, new.state
    using errcode = '55000';
end;
$$;

drop trigger if exists provider_mutation_commands_transition_guard on public.provider_mutation_commands;
create trigger provider_mutation_commands_transition_guard
  before update on public.provider_mutation_commands
  for each row execute function public.guard_provider_mutation_command_transition();
revoke all on function public.guard_provider_mutation_command_transition() from public, anon, authenticated;

create or replace function public.prepare_provider_mutation_command(
  p_user_id uuid,
  p_idempotency_key text,
  p_semantic_hash text,
  p_kind text,
  p_provider text,
  p_transport text,
  p_connection_ref text default null,
  p_target_resource_id uuid default null,
  p_external_resource_id text default null,
  p_deletion_cohort_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command public.provider_mutation_commands%rowtype;
  v_inserted boolean := false;
  v_gcal_event_id text;
  v_outlook_event_id text;
  v_delete_expected_count smallint;
  v_deleted_at timestamptz;
  v_cleanup_state text;
  v_existing_cohort_count integer;
  v_existing_provider_count integer;
begin
  perform private.require_service_role();

  -- A calendar-delete command is accepted only for an external id currently
  -- owned by this row. The row-derived expected count is immutable evidence
  -- that a later command completion cannot confirm a partially prepared
  -- provider cohort.
  if p_kind = 'calendar_delete' then
    select gcal_event_id, outlook_event_id, deleted_at, external_cleanup_state
    into v_gcal_event_id, v_outlook_event_id, v_deleted_at, v_cleanup_state
    from public.schedule_events
    where id = p_target_resource_id and user_id = p_user_id
    for update;
    if not found then
      raise exception 'calendar delete target is not owned by command user' using errcode = '42501';
    end if;
    v_delete_expected_count :=
      (case when v_gcal_event_id is not null then 1 else 0 end)
      + (case when v_outlook_event_id is not null then 1 else 0 end);
    if v_delete_expected_count = 0
      or (p_provider = 'googlecalendar' and p_external_resource_id is distinct from v_gcal_event_id)
      or (p_provider = 'outlook' and p_external_resource_id is distinct from v_outlook_event_id) then
      raise exception 'calendar delete provider target is not owned by command user' using errcode = '42501';
    end if;
  elsif p_kind = 'calendar_create' then
    -- Lock and validate the local creation target before inserting the command.
    -- This serializes with delete_local_schedule_event, so a delete-first
    -- race fails deliberately before durable insert rather than as a raw FK
    -- violation after the event row has gone away.
    perform 1 from public.schedule_events
    where id = p_target_resource_id and user_id = p_user_id and deleted_at is null
    for update;
    if not found then
      raise exception 'calendar create target is not owned by command user' using errcode = '42501';
    end if;
  end if;

  insert into public.provider_mutation_commands (
    user_id, idempotency_key, semantic_hash, kind, provider, transport,
    connection_ref, target_resource_id, external_resource_id, deletion_cohort_id, deletion_expected_count
  ) values (
    p_user_id, p_idempotency_key, p_semantic_hash, p_kind, p_provider, p_transport,
    p_connection_ref, p_target_resource_id, p_external_resource_id, p_deletion_cohort_id,
    case when p_kind = 'calendar_delete' then v_delete_expected_count else null end
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_command;

  v_inserted := found;
  if not v_inserted then
    select * into v_command
    from public.provider_mutation_commands
    where user_id = p_user_id and idempotency_key = p_idempotency_key
    for update;
    if v_command.semantic_hash <> p_semantic_hash then
      return jsonb_build_object('outcome', 'idempotency_conflict', 'command', to_jsonb(v_command));
    end if;
    return jsonb_build_object('outcome', 'replayed', 'command', to_jsonb(v_command));
  end if;

  if p_kind = 'calendar_delete' then
    -- The row may be tombstoned only while this exact cohort is still being
    -- populated. That permits its second provider command after the first
    -- command commits, but rejects a new cohort/key or duplicate provider
    -- command once deletion has begun. Raising rolls back the fresh insert.
    if v_deleted_at is not null or v_cleanup_state <> 'active' then
      select
        count(*),
        count(*) filter (where provider = p_provider)
      into v_existing_cohort_count, v_existing_provider_count
      from public.provider_mutation_commands
      where target_resource_id = p_target_resource_id
        and kind = 'calendar_delete'
        and deletion_cohort_id = p_deletion_cohort_id
        and id <> v_command.id;
      if v_existing_cohort_count = 0
        or v_existing_cohort_count >= v_delete_expected_count
        or v_existing_provider_count > 0 then
        raise exception 'calendar delete cohort is already in progress or complete' using errcode = '55000';
      end if;
    end if;
    update public.schedule_events
    set deleted_at = coalesce(deleted_at, clock_timestamp()),
        external_cleanup_state = case
          when external_cleanup_state = 'reconciliation_required' then 'reconciliation_required'
          else 'pending'
        end,
        calendar_delete_command_id = v_command.id,
        updated_at = clock_timestamp()
    where id = p_target_resource_id and user_id = p_user_id;
    if not found then
      raise exception 'calendar delete target is not owned by command user' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object('outcome', 'created', 'command', to_jsonb(v_command));
end;
$$;

create or replace function public.delete_local_schedule_event(
  p_user_id uuid,
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_gcal_event_id text;
  v_outlook_event_id text;
begin
  perform private.require_service_role();
  -- Serialize against prepare_provider_mutation_command's matching FOR UPDATE
  -- lock. Either deletion wins before a command exists (so prepare fails
  -- before dispatch), or prepare wins and this RPC returns a typed linked
  -- outcome. Never rely on a late FK RESTRICT error for that race.
  select id, gcal_event_id, outlook_event_id
  into v_event_id, v_gcal_event_id, v_outlook_event_id
  from public.schedule_events
  where id = p_event_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_deletable');
  end if;
  -- Any non-terminal or externally linked calendar-create command keeps this
  -- row as its restrictive-FK audit anchor. A cohort consisting entirely of
  -- failed-before-dispatch creates never touched a provider, so it can resolve
  -- to a scrubbed tombstone without losing command evidence.
  if exists (
    select 1 from public.provider_mutation_commands
    where user_id = p_user_id
      and target_resource_id = p_event_id
      and kind = 'calendar_create'
  ) and (
    v_gcal_event_id is not null
    or v_outlook_event_id is not null
    or exists (
      select 1 from public.provider_mutation_commands
      where user_id = p_user_id
        and target_resource_id = p_event_id
        and kind = 'calendar_create'
        and state <> 'failed_before_dispatch'
    )
  ) then
    return jsonb_build_object('outcome', 'calendar_creation_linked');
  end if;
  if exists (
    select 1 from public.provider_mutation_commands
    where user_id = p_user_id
      and target_resource_id = p_event_id
      and kind = 'calendar_create'
  ) then
    update public.schedule_events
    set title = '[Deleted event]',
        description = null,
        recurrence_rule = null,
        start_at = date_trunc('day', clock_timestamp()),
        end_at = date_trunc('day', clock_timestamp()) + interval '1 day',
        all_day = true,
        color_class = 'a',
        deleted_at = clock_timestamp(),
        external_cleanup_state = 'confirmed',
        updated_at = clock_timestamp()
    where id = v_event_id and user_id = p_user_id;
    return jsonb_build_object('outcome', 'deleted');
  end if;
  delete from public.schedule_events
  where id = v_event_id and user_id = p_user_id
    and gcal_event_id is null and outlook_event_id is null;
  return jsonb_build_object('outcome', case when found then 'deleted' else 'not_deletable' end);
end;
$$;

create or replace function public.claim_provider_mutation_command(
  p_command_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command public.provider_mutation_commands%rowtype;
begin
  perform private.require_service_role();
  update public.provider_mutation_commands
  set state = 'dispatching', version = version + 1,
      dispatched_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_command_id and version = p_expected_version and state = 'prepared'
  returning * into v_command;
  if found then
    return jsonb_build_object('outcome', 'claimed', 'command', to_jsonb(v_command));
  end if;
  select * into v_command from public.provider_mutation_commands where id = p_command_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  return jsonb_build_object('outcome', 'not_claimable', 'command', to_jsonb(v_command));
end;
$$;

create or replace function public.complete_provider_mutation_command(
  p_command_id uuid,
  p_expected_version integer,
  p_provider_receipt_id text default null,
  p_external_resource_id text default null,
  p_provider_status integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command public.provider_mutation_commands%rowtype;
  v_remaining integer;
  v_cohort_count integer;
begin
  perform private.require_service_role();
  select * into v_command from public.provider_mutation_commands
  where id = p_command_id and version = p_expected_version and state = 'dispatching'
  for update;
  if not found then
    raise exception 'provider mutation command transition conflict' using errcode = '40001';
  end if;
  -- A deletion acknowledgement (including a provider 204) is not proof that
  -- the provider resource is absent. It must pass through reconciliation with
  -- fresh 404/410 evidence before this command can succeed.
  if v_command.kind in ('calendar_delete', 'composio_disconnect') then
    raise exception 'calendar delete completion requires verified reconciliation evidence' using errcode = '22023';
  end if;

  insert into public.provider_mutation_receipts (
    command_id, user_id, receipt_kind, provider_receipt_id, external_resource_id, provider_status
  ) values (
    v_command.id, v_command.user_id, 'provider_acknowledged',
    p_provider_receipt_id, coalesce(p_external_resource_id, v_command.external_resource_id), p_provider_status
  );

  update public.provider_mutation_commands
  set state = 'succeeded', version = version + 1, repair_required = false,
      external_resource_id = coalesce(p_external_resource_id, external_resource_id),
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_command.id
  returning * into v_command;

  if v_command.kind = 'calendar_create' then
    if p_external_resource_id is null then
      raise exception 'calendar create acknowledgement needs external resource id' using errcode = '22023';
    end if;
    if v_command.provider = 'googlecalendar' then
      update public.schedule_events set gcal_event_id = p_external_resource_id, updated_at = clock_timestamp()
      where id = v_command.target_resource_id and user_id = v_command.user_id;
    else
      update public.schedule_events set outlook_event_id = p_external_resource_id, updated_at = clock_timestamp()
      where id = v_command.target_resource_id and user_id = v_command.user_id;
    end if;
  end if;

  return jsonb_build_object('outcome', 'succeeded', 'command', to_jsonb(v_command));
end;
$$;

create or replace function public.fail_provider_mutation_before_dispatch(
  p_command_id uuid,
  p_expected_version integer,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_command public.provider_mutation_commands%rowtype;
begin
  perform private.require_service_role();
  select * into v_command from public.provider_mutation_commands
  where id = p_command_id and version = p_expected_version and state = 'prepared'
  for update;
  if not found then raise exception 'provider mutation command transition conflict' using errcode = '40001'; end if;
  insert into public.provider_mutation_receipts(command_id, user_id, receipt_kind, error_code)
  values(v_command.id, v_command.user_id, 'provider_rejected', p_error_code);
  update public.provider_mutation_commands
  set state = 'failed_before_dispatch', version = version + 1, last_error_code = p_error_code,
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_command.id returning * into v_command;
  return jsonb_build_object('outcome', 'failed_before_dispatch', 'command', to_jsonb(v_command));
end;
$$;

create or replace function public.mark_provider_mutation_outcome_unknown(
  p_command_id uuid,
  p_expected_version integer,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_command public.provider_mutation_commands%rowtype;
begin
  perform private.require_service_role();
  select * into v_command from public.provider_mutation_commands
  where id = p_command_id and version = p_expected_version and state = 'dispatching'
  for update;
  if not found then raise exception 'provider mutation command transition conflict' using errcode = '40001'; end if;
  insert into public.provider_mutation_receipts(command_id, user_id, receipt_kind, error_code)
  values(v_command.id, v_command.user_id, 'outcome_unknown', p_error_code);
  update public.provider_mutation_commands
  set state = 'outcome_unknown', version = version + 1, repair_required = true,
      last_error_code = p_error_code, completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_command.id returning * into v_command;
  if v_command.kind = 'calendar_delete' then
    update public.schedule_events set external_cleanup_state = 'reconciliation_required', updated_at = clock_timestamp()
    where id = v_command.target_resource_id and user_id = v_command.user_id;
  end if;
  return jsonb_build_object('outcome', 'outcome_unknown', 'command', to_jsonb(v_command));
end;
$$;

-- A pre-dispatch rejection has durable proof that no provider call was made.
-- It may be reopened after configuration/ownership recovery; claimed commands
-- are intentionally ineligible and must reconcile rather than resend.
drop function if exists public.reopen_provider_mutation_before_dispatch(uuid, integer);
create or replace function public.reopen_provider_mutation_before_dispatch(
  p_command_id uuid,
  p_expected_version integer,
  p_semantic_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command public.provider_mutation_commands%rowtype;
begin
  perform private.require_service_role();
  update public.provider_mutation_commands
  set state = 'prepared', version = version + 1, repair_required = false,
      semantic_hash = coalesce(p_semantic_hash, semantic_hash),
      last_error_code = null, completed_at = null, updated_at = clock_timestamp()
  where id = p_command_id and version = p_expected_version
    and state = 'failed_before_dispatch' and dispatched_at is null
  returning * into v_command;
  if not found then
    raise exception 'provider mutation pre-dispatch reopen conflict' using errcode = '40001';
  end if;
  return jsonb_build_object('outcome', 'reopened', 'command', to_jsonb(v_command));
end;
$$;

-- Operational sweeper: a process crash after claim never grants a resend.
-- A scheduled worker calls this service-role RPC to convert aged dispatches
-- into durable reconciliation work and append outcome evidence.
create or replace function public.sweep_stale_provider_mutation_commands(
  p_min_age_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require_service_role();
  if p_min_age_seconds < 60 or p_min_age_seconds > 86400 then
    raise exception 'provider mutation sweep age is outside safe bounds' using errcode = '22023';
  end if;
  insert into public.provider_mutation_receipts(command_id, user_id, receipt_kind, error_code)
  select id, user_id, 'outcome_unknown', 'timeout'
  from public.provider_mutation_commands
  where state = 'dispatching' and dispatched_at < clock_timestamp() - make_interval(secs => p_min_age_seconds);
  update public.provider_mutation_commands
  set state = 'outcome_unknown', version = version + 1, repair_required = true,
      last_error_code = 'timeout', completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where state = 'dispatching' and dispatched_at < clock_timestamp() - make_interval(secs => p_min_age_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.mark_provider_mutation_reconciliation_required(
  p_command_id uuid,
  p_expected_version integer,
  p_reason text,
  p_provider_receipt_id text default null,
  p_external_resource_id text default null,
  p_provider_status integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_command public.provider_mutation_commands%rowtype;
begin
  perform private.require_service_role();
  select * into v_command from public.provider_mutation_commands
  where id = p_command_id and version = p_expected_version and state in ('dispatching', 'outcome_unknown', 'reconciliation_required')
  for update;
  if not found then raise exception 'provider mutation command transition conflict' using errcode = '40001'; end if;
  insert into public.provider_mutation_receipts(
    command_id, user_id, receipt_kind, provider_receipt_id, external_resource_id, provider_status, error_code
  ) values (
    v_command.id, v_command.user_id, 'reconciliation_required',
    p_provider_receipt_id, coalesce(p_external_resource_id, v_command.external_resource_id), p_provider_status, p_reason
  );
  update public.provider_mutation_commands
  set state = 'reconciliation_required', version = version + 1, repair_required = true,
      last_error_code = p_reason, completed_at = coalesce(completed_at, clock_timestamp()), updated_at = clock_timestamp()
  where id = v_command.id returning * into v_command;
  if v_command.kind = 'calendar_delete' then
    update public.schedule_events set external_cleanup_state = 'reconciliation_required', updated_at = clock_timestamp()
    where id = v_command.target_resource_id and user_id = v_command.user_id;
  end if;
  return jsonb_build_object('outcome', 'reconciliation_required', 'command', to_jsonb(v_command));
end;
$$;

create or replace function public.reconcile_provider_mutation_command(
  p_command_id uuid,
  p_expected_version integer,
  p_provider_receipt_id text default null,
  p_external_resource_id text default null,
  p_provider_status integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_command public.provider_mutation_commands%rowtype;
declare v_remaining integer;
declare v_cohort_count integer;
begin
  perform private.require_service_role();
  select * into v_command from public.provider_mutation_commands
  where id = p_command_id and version = p_expected_version and state in ('outcome_unknown', 'reconciliation_required')
  for update;
  if not found then raise exception 'provider mutation command transition conflict' using errcode = '40001'; end if;
  if p_provider_receipt_id is null and p_external_resource_id is null and p_provider_status is null then
    raise exception 'provider mutation reconciliation requires new provider evidence' using errcode = '22023';
  end if;
  if v_command.kind = 'calendar_create' and p_external_resource_id is null then
    raise exception 'calendar create reconciliation requires observed external resource id' using errcode = '22023';
  end if;
  if v_command.kind in ('calendar_delete', 'composio_disconnect') and (p_provider_status is null or p_provider_status not in (404, 410)) then
    raise exception 'provider deletion reconciliation requires verified absent status' using errcode = '22023';
  end if;
  insert into public.provider_mutation_receipts(
    command_id, user_id, receipt_kind, provider_receipt_id, external_resource_id, provider_status, error_code
  ) values (
    v_command.id, v_command.user_id, 'reconciled', p_provider_receipt_id,
    coalesce(p_external_resource_id, v_command.external_resource_id), p_provider_status,
    'confirmed'
  );
  update public.provider_mutation_commands
  set state = 'succeeded',
      version = version + 1, repair_required = false,
      external_resource_id = coalesce(p_external_resource_id, external_resource_id),
      last_error_code = null,
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_command.id returning * into v_command;
  if v_command.kind = 'calendar_delete' then
    select
      count(*),
      count(*) filter (where state <> 'succeeded')
    into v_cohort_count, v_remaining
    from public.provider_mutation_commands
    where target_resource_id = v_command.target_resource_id
      and kind = 'calendar_delete'
      and deletion_cohort_id = v_command.deletion_cohort_id;
    update public.schedule_events
    set external_cleanup_state = case
          when v_cohort_count = v_command.deletion_expected_count and v_remaining = 0 then 'confirmed'
          else 'reconciliation_required'
        end,
        updated_at = clock_timestamp()
    where id = v_command.target_resource_id and user_id = v_command.user_id;
  end if;
  return jsonb_build_object('outcome', 'succeeded', 'command', to_jsonb(v_command));
end;
$$;

revoke all on function public.prepare_provider_mutation_command(uuid, text, text, text, text, text, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_local_schedule_event(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_provider_mutation_command(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_provider_mutation_command(uuid, integer, text, text, integer) from public, anon, authenticated;
revoke all on function public.fail_provider_mutation_before_dispatch(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.mark_provider_mutation_outcome_unknown(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.reopen_provider_mutation_before_dispatch(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.sweep_stale_provider_mutation_commands(integer) from public, anon, authenticated;
revoke all on function public.mark_provider_mutation_reconciliation_required(uuid, integer, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.reconcile_provider_mutation_command(uuid, integer, text, text, integer) from public, anon, authenticated;

grant execute on function public.prepare_provider_mutation_command(uuid, text, text, text, text, text, text, uuid, text, uuid) to service_role;
grant execute on function public.delete_local_schedule_event(uuid, uuid) to service_role;
grant execute on function public.claim_provider_mutation_command(uuid, integer) to service_role;
grant execute on function public.complete_provider_mutation_command(uuid, integer, text, text, integer) to service_role;
grant execute on function public.fail_provider_mutation_before_dispatch(uuid, integer, text) to service_role;
grant execute on function public.mark_provider_mutation_outcome_unknown(uuid, integer, text) to service_role;
grant execute on function public.reopen_provider_mutation_before_dispatch(uuid, integer, text) to service_role;
grant execute on function public.sweep_stale_provider_mutation_commands(integer) to service_role;
grant execute on function public.mark_provider_mutation_reconciliation_required(uuid, integer, text, text, text, integer) to service_role;
grant execute on function public.reconcile_provider_mutation_command(uuid, integer, text, text, integer) to service_role;

comment on table public.provider_mutation_commands is
  'Durable service-role-only provider mutation intents. A post-dispatch timeout is outcome_unknown, never permission to retry.';
comment on table public.provider_mutation_receipts is
  'Append-only safe provider mutation evidence; no request payloads or provider response bodies are stored.';

commit;
