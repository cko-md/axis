-- Provider identity authority (contract phase).
-- Apply only after 20260723210000 and the compatible opaque-connection app
-- revision are deployed. No legacy row is deleted: unmatched cache identities
-- remain server-only for recovery but cannot authorize dispatch.
begin;

alter table public.composio_connections enable row level security;
drop policy if exists "composio_connections_select_own" on public.composio_connections;
drop policy if exists "composio_connections_insert_own" on public.composio_connections;
drop policy if exists "composio_connections_update_own" on public.composio_connections;
drop policy if exists "composio_connections_delete_own" on public.composio_connections;
revoke all on public.composio_connections from anon, authenticated;
grant select, insert, update, delete on public.composio_connections to service_role;

alter table public.mail_message_cache enable row level security;
drop policy if exists "mail_message_cache_select_own" on public.mail_message_cache;
drop policy if exists "mail_message_cache_insert_own" on public.mail_message_cache;
drop policy if exists "mail_message_cache_update_own" on public.mail_message_cache;
drop policy if exists "mail_message_cache_delete_own" on public.mail_message_cache;
revoke all on public.mail_message_cache from anon, authenticated;
grant select, insert, update, delete on public.mail_message_cache to service_role;

alter table public.integration_sync_state enable row level security;
drop policy if exists "integration_sync_state_select_own" on public.integration_sync_state;
drop policy if exists "integration_sync_state_insert_own" on public.integration_sync_state;
drop policy if exists "integration_sync_state_update_own" on public.integration_sync_state;
drop policy if exists "integration_sync_state_delete_own" on public.integration_sync_state;
revoke all on public.integration_sync_state from anon, authenticated;
grant select, insert, update, delete on public.integration_sync_state to service_role;

-- Safe browser status remains the security-barrier projection from expand.
revoke all on public.composio_connection_status from anon;
grant select on public.composio_connection_status to authenticated;
commit;
