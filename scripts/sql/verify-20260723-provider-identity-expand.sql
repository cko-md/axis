-- Read-only verifier for the additive Phase 1B expand migration only.
-- Run after 20260723210000_composio_connection_identity_expand.sql and before
-- the contract migration: legacy browser access must still be available, but
-- private authority membership must remain service-only.
do $$
begin
  if not has_table_privilege('authenticated', 'public.composio_connections', 'SELECT') then
    raise exception 'expand phase removed legacy composio_connections SELECT access';
  end if;
  if not has_table_privilege('authenticated', 'public.mail_message_cache', 'SELECT') then
    raise exception 'expand phase removed legacy mail cache SELECT access';
  end if;
  -- This is baseline behavior, not a contract-phase tightening: client DELETE
  -- has never been an allowed cache/connection mutation path.
  if has_table_privilege('authenticated', 'public.composio_connections', 'DELETE')
     or has_table_privilege('authenticated', 'public.mail_message_cache', 'DELETE')
     or has_table_privilege('authenticated', 'public.integration_sync_state', 'DELETE') then
    raise exception 'expand phase widened authenticated DELETE access';
  end if;

  if has_table_privilege('authenticated', 'public.composio_connection_authorities', 'SELECT')
     or has_table_privilege('authenticated', 'public.composio_connection_authorities', 'INSERT')
     or has_table_privilege('authenticated', 'public.composio_connection_authorities', 'UPDATE')
     or has_table_privilege('authenticated', 'public.composio_connection_authorities', 'DELETE') then
    raise exception 'authenticated can read or forge private provider authority during expand';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_message_cache'
      and column_name = 'composio_connection_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'integration_sync_state'
      and column_name = 'composio_connection_id'
  ) then
    raise exception 'expand phase did not add opaque cache/sync connection references';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mail_message_cache'::regclass
      and conname = 'mail_message_cache_composio_opaque_ref_required'
      and not convalidated
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.integration_sync_state'::regclass
      and conname = 'integration_sync_state_composio_opaque_ref_required'
      and not convalidated
  ) then
    raise exception 'expand phase does not enforce opaque references for new Composio cache/sync writes';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.composio_connection_authorities'::regclass
      and contype = 'p'
  ) then
    raise exception 'provider authority table lacks the local connection primary key';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.composio_connection_authorities'::regclass
      and contype = 'f'
      and confrelid = 'public.composio_connections'::regclass
      and array_length(conkey, 1) = 2
      and array_length(confkey, 1) = 2
  ) then
    raise exception 'provider authority table lacks same-owner composite foreign key';
  end if;
end
$$;
