-- Read-only verifier for the Phase 1B contract migration.
-- Run after both 20260723210000_composio_connection_identity_expand.sql and
-- 20260723210001_composio_connection_identity_contract.sql.
do $$
declare
  exposed_raw_columns text[];
  status_view text;
begin
  -- Authenticated clients must not be able to select a cache row containing
  -- connected_account_id, even when the row belongs to them. The opaque local
  -- composio_connection_id is the only permitted account selector.
  if has_table_privilege('authenticated', 'public.mail_message_cache', 'SELECT') then
    raise exception 'authenticated may SELECT mail_message_cache, leaking connected_account_id';
  end if;

  if has_table_privilege('authenticated', 'public.composio_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.composio_connections', 'INSERT')
     or has_table_privilege('authenticated', 'public.composio_connections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.composio_connections', 'DELETE') then
    raise exception 'authenticated has direct composio_connections authority access';
  end if;
  if has_table_privilege('authenticated', 'public.composio_connections', 'DELETE')
     or has_table_privilege('authenticated', 'public.mail_message_cache', 'DELETE')
     or has_table_privilege('authenticated', 'public.integration_sync_state', 'DELETE') then
    raise exception 'contract unexpectedly permits authenticated DELETE';
  end if;

  if has_table_privilege('authenticated', 'public.composio_connection_authorities', 'SELECT')
     or has_table_privilege('authenticated', 'public.composio_connection_authorities', 'INSERT')
     or has_table_privilege('authenticated', 'public.composio_connection_authorities', 'UPDATE')
     or has_table_privilege('authenticated', 'public.composio_connection_authorities', 'DELETE') then
    raise exception 'authenticated can read or forge private provider authority';
  end if;

  select array_agg(column_name order by column_name)
  into exposed_raw_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'composio_connection_status'
    and column_name in ('user_id', 'connected_account_id', 'auth_config_id', 'lifecycle_version', 'verification_error_code');

  if coalesce(array_length(exposed_raw_columns, 1), 0) <> 0 then
    raise exception 'safe connection projection exposes internal columns: %', exposed_raw_columns;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'mail_message_cache'
      and column_name = 'composio_connection_id'
  ) then
    raise exception 'mail cache has no opaque composio_connection_id';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mail_message_cache'::regclass
      and conname = 'mail_message_cache_composio_opaque_ref_required'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.integration_sync_state'::regclass
      and conname = 'integration_sync_state_composio_opaque_ref_required'
  ) then
    raise exception 'contract lacks opaque Composio cache/sync write constraints';
  end if;

  select pg_get_viewdef('public.composio_connection_status'::regclass, true) into status_view;
  if status_view not like '%last_observation = ''ACTIVE''%'
     or status_view not like '%10 minutes%'
     or status_view not like '%1 minute%'
     or status_view not like '%RECONNECT_REQUIRED%' then
    raise exception 'safe status projection is not freshness-aware';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.composio_connection_authorities'::regclass
      and contype = 'p'
  ) then
    raise exception 'provider authority table lacks its local connection primary key';
  end if;
end
$$;
