-- Phase 7: canonical entity workspace persistence.
--
-- Existing module tables remain the content source of truth. These two small
-- owner-scoped tables persist only (a) typed edges/backlinks and (b) aggregate
-- explicit-use counts for cross-device frecency. Raw search queries, previews,
-- entity content, and pane history are deliberately not stored here.

create table if not exists public.entity_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_kind text not null check (source_kind in (
    'note', 'task', 'agenda_task', 'person', 'signal',
    'approval', 'routine_run', 'account', 'holding'
  )),
  source_id text not null check (char_length(source_id) between 1 and 256),
  target_kind text not null check (target_kind in (
    'note', 'task', 'agenda_task', 'person', 'signal',
    'approval', 'routine_run', 'account', 'holding'
  )),
  target_id text not null check (char_length(target_id) between 1 and 256),
  relation text not null default 'related'
    check (relation in ('related', 'supports', 'blocks', 'mentions')),
  label text check (label is null or char_length(label) between 1 and 120),
  origin text not null default 'user' check (origin in ('user', 'system')),
  created_at timestamptz not null default now(),
  check ((source_kind, source_id) <> (target_kind, target_id)),
  unique (user_id, source_kind, source_id, target_kind, target_id, relation)
);

create index if not exists idx_entity_references_outgoing
  on public.entity_references (user_id, source_kind, source_id, created_at desc);
create index if not exists idx_entity_references_backlinks
  on public.entity_references (user_id, target_kind, target_id, created_at desc);

create table if not exists public.entity_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_kind text not null check (entity_kind in (
    'note', 'task', 'agenda_task', 'person', 'signal',
    'approval', 'routine_run', 'account', 'holding'
  )),
  entity_id text not null check (char_length(entity_id) between 1 and 256),
  direct_open_count bigint not null default 0 check (direct_open_count >= 0),
  search_select_count bigint not null default 0 check (search_select_count >= 0),
  command_count bigint not null default 0 check (command_count >= 0),
  link_count bigint not null default 0 check (link_count >= 0),
  last_direct_open_at timestamptz,
  last_search_select_at timestamptz,
  last_command_at timestamptz,
  last_link_at timestamptz,
  last_used_at timestamptz not null default now(),
  last_action text not null check (last_action in ('direct', 'search', 'command', 'link')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_kind, entity_id)
);

create index if not exists idx_entity_usage_recent
  on public.entity_usage (user_id, last_used_at desc);

alter table public.entity_references enable row level security;
alter table public.entity_usage enable row level security;

drop policy if exists "entity_references_select_own" on public.entity_references;
create policy "entity_references_select_own"
  on public.entity_references for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "entity_usage_select_own" on public.entity_usage;
create policy "entity_usage_select_own"
  on public.entity_usage for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.entity_references from public, anon, authenticated;
revoke all on public.entity_usage from public, anon, authenticated;
grant select on public.entity_references to authenticated;
grant select on public.entity_usage to authenticated;
grant all on public.entity_references to service_role;
grant all on public.entity_usage to service_role;

-- Internal ownership resolver used only by the narrowly-scoped RPCs below.
-- UUID casts are gated; holding identity is the normalized symbol because that
-- is the existing canonical detail route and may span provider-partitioned rows.
create or replace function public.axis_entity_ref_owned(
  p_user_id uuid,
  p_kind text,
  p_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uuid uuid;
begin
  if p_user_id is null or p_id is null or char_length(p_id) not between 1 and 256 then
    return false;
  end if;

  if p_kind = 'holding' then
    return p_id ~ '^[A-Za-z0-9.-]{1,32}$'
      and exists (
        select 1 from public.fund_holdings
        where user_id = p_user_id and upper(symbol) = upper(p_id)
      );
  end if;

  if p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_uuid := p_id::uuid;

  return case p_kind
    when 'note' then exists (
      select 1 from public.notes where id = v_uuid and user_id = p_user_id
    )
    when 'task' then exists (
      select 1 from public.agent_tasks where id = v_uuid and user_id = p_user_id
    )
    when 'agenda_task' then exists (
      select 1 from public.tasks where id = v_uuid and user_id = p_user_id
    )
    when 'person' then exists (
      select 1 from public.people where id = v_uuid and user_id = p_user_id
    )
    when 'signal' then exists (
      select 1 from public.signals where id = v_uuid and user_id = p_user_id
    )
    when 'approval' then exists (
      select 1 from public.approvals where id = v_uuid and user_id = p_user_id
    )
    when 'routine_run' then exists (
      select 1 from public.routine_runs where id = v_uuid and user_id = p_user_id
    )
    when 'account' then exists (
      select 1 from public.fund_connections where id = v_uuid and user_id = p_user_id
    )
    else false
  end;
end;
$$;

revoke all on function public.axis_entity_ref_owned(uuid, text, text) from public, anon, authenticated;

create or replace function public.create_entity_reference(
  p_source_kind text,
  p_source_id text,
  p_target_kind text,
  p_target_id text,
  p_relation text default 'related',
  p_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.axis_entity_ref_owned(v_user_id, p_source_kind, p_source_id)
     or not public.axis_entity_ref_owned(v_user_id, p_target_kind, p_target_id) then
    raise exception 'ENTITY_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.entity_references (
    user_id, source_kind, source_id, target_kind, target_id, relation, label, origin
  ) values (
    v_user_id, p_source_kind, p_source_id, p_target_kind, p_target_id,
    p_relation, nullif(btrim(p_label), ''), 'user'
  )
  on conflict (user_id, source_kind, source_id, target_kind, target_id, relation)
  do update set label = excluded.label
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.delete_entity_reference(p_reference_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted bigint;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  delete from public.entity_references
    where id = p_reference_id and user_id = v_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.record_entity_usage(
  p_entity_kind text,
  p_entity_id text,
  p_action text
)
returns public.entity_usage
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_row public.entity_usage;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_action not in ('direct', 'search', 'command', 'link') then
    raise exception 'INVALID_USAGE_ACTION' using errcode = '22023';
  end if;
  if not public.axis_entity_ref_owned(v_user_id, p_entity_kind, p_entity_id) then
    raise exception 'ENTITY_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.entity_usage (
    user_id, entity_kind, entity_id,
    direct_open_count, search_select_count, command_count, link_count,
    last_direct_open_at, last_search_select_at, last_command_at, last_link_at,
    last_used_at, last_action, updated_at
  ) values (
    v_user_id, p_entity_kind, p_entity_id,
    case when p_action = 'direct' then 1 else 0 end,
    case when p_action = 'search' then 1 else 0 end,
    case when p_action = 'command' then 1 else 0 end,
    case when p_action = 'link' then 1 else 0 end,
    case when p_action = 'direct' then v_now end,
    case when p_action = 'search' then v_now end,
    case when p_action = 'command' then v_now end,
    case when p_action = 'link' then v_now end,
    v_now, p_action, v_now
  )
  on conflict (user_id, entity_kind, entity_id) do update set
    direct_open_count = public.entity_usage.direct_open_count + excluded.direct_open_count,
    search_select_count = public.entity_usage.search_select_count + excluded.search_select_count,
    command_count = public.entity_usage.command_count + excluded.command_count,
    link_count = public.entity_usage.link_count + excluded.link_count,
    last_direct_open_at = coalesce(excluded.last_direct_open_at, public.entity_usage.last_direct_open_at),
    last_search_select_at = coalesce(excluded.last_search_select_at, public.entity_usage.last_search_select_at),
    last_command_at = coalesce(excluded.last_command_at, public.entity_usage.last_command_at),
    last_link_at = coalesce(excluded.last_link_at, public.entity_usage.last_link_at),
    last_used_at = excluded.last_used_at,
    last_action = excluded.last_action,
    updated_at = excluded.updated_at
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_entity_reference(text, text, text, text, text, text) from public, anon;
revoke all on function public.delete_entity_reference(uuid) from public, anon;
revoke all on function public.record_entity_usage(text, text, text) from public, anon;
grant execute on function public.create_entity_reference(text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.delete_entity_reference(uuid) to authenticated, service_role;
grant execute on function public.record_entity_usage(text, text, text) to authenticated, service_role;

-- Keep the polymorphic graph tidy when a source row is deleted. This trigger
-- never trusts content from a row; it uses only owner, kind, and canonical id.
create or replace function public.cleanup_entity_workspace_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := tg_argv[0];
  v_id text;
begin
  if v_kind = 'holding' then
    v_id := upper(old.symbol);
    if exists (
      select 1 from public.fund_holdings
      where user_id = old.user_id and upper(symbol) = v_id
    ) then
      return old;
    end if;
  else
    v_id := old.id::text;
  end if;

  delete from public.entity_references
    where user_id = old.user_id
      and ((source_kind = v_kind and source_id = v_id)
        or (target_kind = v_kind and target_id = v_id));
  delete from public.entity_usage
    where user_id = old.user_id and entity_kind = v_kind and entity_id = v_id;
  return old;
end;
$$;

revoke all on function public.cleanup_entity_workspace_state() from public, anon, authenticated;

drop trigger if exists cleanup_note_workspace_state on public.notes;
create trigger cleanup_note_workspace_state after delete on public.notes
  for each row execute function public.cleanup_entity_workspace_state('note');
drop trigger if exists cleanup_task_workspace_state on public.agent_tasks;
create trigger cleanup_task_workspace_state after delete on public.agent_tasks
  for each row execute function public.cleanup_entity_workspace_state('task');
drop trigger if exists cleanup_agenda_task_workspace_state on public.tasks;
create trigger cleanup_agenda_task_workspace_state after delete on public.tasks
  for each row execute function public.cleanup_entity_workspace_state('agenda_task');
drop trigger if exists cleanup_person_workspace_state on public.people;
create trigger cleanup_person_workspace_state after delete on public.people
  for each row execute function public.cleanup_entity_workspace_state('person');
drop trigger if exists cleanup_signal_workspace_state on public.signals;
create trigger cleanup_signal_workspace_state after delete on public.signals
  for each row execute function public.cleanup_entity_workspace_state('signal');
drop trigger if exists cleanup_approval_workspace_state on public.approvals;
create trigger cleanup_approval_workspace_state after delete on public.approvals
  for each row execute function public.cleanup_entity_workspace_state('approval');
drop trigger if exists cleanup_routine_run_workspace_state on public.routine_runs;
create trigger cleanup_routine_run_workspace_state after delete on public.routine_runs
  for each row execute function public.cleanup_entity_workspace_state('routine_run');
drop trigger if exists cleanup_account_workspace_state on public.fund_connections;
create trigger cleanup_account_workspace_state after delete on public.fund_connections
  for each row execute function public.cleanup_entity_workspace_state('account');
drop trigger if exists cleanup_holding_workspace_state on public.fund_holdings;
create trigger cleanup_holding_workspace_state after delete on public.fund_holdings
  for each row execute function public.cleanup_entity_workspace_state('holding');

-- RLS review:
-- - authenticated clients can read only rows where auth.uid() = user_id;
-- - no direct client mutation grants exist;
-- - mutation RPCs derive auth.uid(), validate every endpoint against its
--   owner-scoped source table, and use fixed empty search paths;
-- - anon/public cannot execute the RPCs or internal resolver/cleanup function;
-- - no entity content, provider credentials, query text, or pane state is stored.
