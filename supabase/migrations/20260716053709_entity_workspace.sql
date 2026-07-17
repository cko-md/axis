-- 20260716053709_entity_workspace.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live schema + function bodies
-- (pg_get_functiondef) on 2026-07-17.
--
-- Cross-module entity linking: entity_references records a typed edge
-- between two owned entities (e.g. note -> task, person -> signal);
-- entity_usage tracks recency/frequency of interaction per entity for
-- ranking in search/command palettes. axis_entity_ref_owned() is the single
-- ownership check every entity kind funnels through so new kinds don't need
-- new RLS policies. cleanup_entity_workspace_state() exists as a trigger
-- function for cascading entity_references/entity_usage deletes when an
-- owning row is deleted, but introspection found no triggers currently wired
-- to it on any table — it's present but unused; left as-is rather than
-- guessing which tables should carry it.

create table if not exists public.entity_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_kind text not null,
  source_id text not null,
  target_kind text not null,
  target_id text not null,
  relation text not null default 'related',
  label text,
  origin text not null default 'user',
  created_at timestamptz not null default now(),
  unique (user_id, source_kind, source_id, target_kind, target_id, relation)
);

alter table public.entity_references enable row level security;

drop policy if exists "entity_references_select_own" on public.entity_references;
create policy "entity_references_select_own" on public.entity_references for select using ((select auth.uid()) = user_id);
-- No direct insert/update/delete policy: mutations go through
-- create_entity_reference() / delete_entity_reference() below, which own the
-- ownership check via axis_entity_ref_owned().

create index if not exists idx_entity_references_outgoing
  on public.entity_references (user_id, source_kind, source_id, created_at desc);

create index if not exists idx_entity_references_backlinks
  on public.entity_references (user_id, target_kind, target_id, created_at desc);

create table if not exists public.entity_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_kind text not null,
  entity_id text not null,
  direct_open_count bigint not null default 0,
  search_select_count bigint not null default 0,
  command_count bigint not null default 0,
  link_count bigint not null default 0,
  last_direct_open_at timestamptz,
  last_search_select_at timestamptz,
  last_command_at timestamptz,
  last_link_at timestamptz,
  last_used_at timestamptz not null default now(),
  last_action text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_kind, entity_id)
);

alter table public.entity_usage enable row level security;

drop policy if exists "entity_usage_select_own" on public.entity_usage;
create policy "entity_usage_select_own" on public.entity_usage for select using ((select auth.uid()) = user_id);
-- No direct insert/update/delete policy: mutations go through
-- record_entity_usage() below.

create index if not exists idx_entity_usage_recent
  on public.entity_usage (user_id, last_used_at desc);

create or replace function public.axis_entity_ref_owned(p_user_id uuid, p_kind text, p_id text)
returns boolean
language plpgsql
stable security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.axis_entity_ref_owned(uuid, text, text) from public;
grant execute on function public.axis_entity_ref_owned(uuid, text, text) to service_role;

create or replace function public.create_entity_reference(p_source_kind text, p_source_id text, p_target_kind text, p_target_id text, p_relation text default 'related', p_label text default null)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.create_entity_reference(text, text, text, text, text, text) from public;
grant execute on function public.create_entity_reference(text, text, text, text, text, text) to authenticated, service_role;

create or replace function public.delete_entity_reference(p_reference_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.delete_entity_reference(uuid) from public;
grant execute on function public.delete_entity_reference(uuid) to authenticated, service_role;

create or replace function public.record_entity_usage(p_entity_kind text, p_entity_id text, p_action text)
returns entity_usage
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.record_entity_usage(text, text, text) from public;
grant execute on function public.record_entity_usage(text, text, text) to authenticated, service_role;

create or replace function public.cleanup_entity_workspace_state()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.cleanup_entity_workspace_state() from public;
grant execute on function public.cleanup_entity_workspace_state() to service_role;
