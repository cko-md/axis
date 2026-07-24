-- Fresh Supabase CLI projects no longer auto-grant public-schema tables to
-- Data API roles. Derive local-only table privileges from the committed RLS
-- policies so authenticated browser tests exercise the intended contract.
--
-- This is deliberately stricter than GRANT ALL ON ALL TABLES: contract
-- migrations remove lifecycle write policies, so those writes remain
-- privilege-blocked in CI as they are in production.

begin;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

do $$
declare
  policy record;
  privileges text;
begin
  for policy in
    select schemaname, tablename, cmd, roles
    from pg_policies
    where schemaname = 'public'
  loop
    privileges := case policy.cmd
      when 'SELECT' then 'select'
      when 'INSERT' then 'insert'
      when 'UPDATE' then 'update'
      when 'DELETE' then 'delete'
      when 'ALL' then 'select, insert, update, delete'
      else null
    end;

    if privileges is null then
      raise exception 'unsupported RLS command % on %.%',
        policy.cmd,
        policy.schemaname,
        policy.tablename;
    end if;

    if 'public' = any(policy.roles) then
      execute format(
        'grant %s on table %I.%I to anon, authenticated',
        privileges,
        policy.schemaname,
        policy.tablename
      );
    else
      if 'anon' = any(policy.roles) then
        execute format(
          'grant %s on table %I.%I to anon',
          privileges,
          policy.schemaname,
          policy.tablename
        );
      end if;
      if 'authenticated' = any(policy.roles) then
        execute format(
          'grant %s on table %I.%I to authenticated',
          privileges,
          policy.schemaname,
          policy.tablename
        );
      end if;
    end if;
  end loop;
end
$$;

-- RLS policies define row visibility, but the final lifecycle contract also
-- uses table privileges to keep browser sessions read-only. Re-assert those
-- revocations after deriving grants so an older FOR ALL policy can never undo
-- the contract in a fresh CI database.
revoke insert, update, delete on public.agent_tasks from anon, authenticated;
revoke insert on public.agent_task_activity from anon, authenticated;
revoke insert, update on public.approvals from anon, authenticated;
revoke all privileges on public.fund_connections from anon, authenticated;
grant select (
  id,
  user_id,
  provider,
  institution,
  mask,
  status,
  authority,
  verified_at,
  created_at,
  updated_at
) on public.fund_connections to authenticated;
revoke all privileges on public.user_passkeys from anon, authenticated;
grant select (
  id,
  user_id,
  credential_id,
  credential_public_key,
  counter,
  device_type,
  backed_up,
  transports,
  name,
  created_at,
  last_used_at
) on public.user_passkeys to authenticated;

-- PostgREST does not expose sequences directly. Usage is required only when an
-- allowed table insert relies on an identity/serial default.
grant usage, select on all sequences in schema public to anon, authenticated;

commit;
