-- Effective-role verification for provider credential and passkey ciphertext
-- boundaries. Run after all migrations and the local Data API grant bootstrap.

\set ON_ERROR_STOP on

set statement_timeout = '30s';

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'fund_connections'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'browser-write fund_connections policy remains';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'fund_connections'
      and policyname = 'fund_connections_select_own'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ) then
    raise exception 'owner-scoped authenticated fund_connections read policy missing';
  end if;

  if not exists (
    select 1
    from pg_index index_row
    join pg_class index_class on index_class.oid = index_row.indexrelid
    where index_row.indrelid = 'public.fund_connections'::regclass
      and index_class.relname = 'fund_connections_one_active_plaid_per_user'
      and index_row.indisunique
      and pg_get_indexdef(index_row.indexrelid) like '%(user_id)%'
      and pg_get_expr(index_row.indpred, index_row.indrelid) like '%provider%'
      and pg_get_expr(index_row.indpred, index_row.indrelid) like '%plaid%'
      and pg_get_expr(index_row.indpred, index_row.indrelid) like '%status%'
      and pg_get_expr(index_row.indpred, index_row.indrelid) like '%revoked%'
  ) then
    raise exception 'one-active-Plaid-Item unique index is missing or malformed';
  end if;

  if has_table_privilege('anon', 'public.fund_connections', 'select')
    or has_table_privilege('authenticated', 'public.fund_connections', 'insert')
    or has_table_privilege('authenticated', 'public.fund_connections', 'update')
    or has_table_privilege('authenticated', 'public.fund_connections', 'delete')
    or has_column_privilege(
      'authenticated',
      'public.fund_connections',
      'item_id',
      'select'
    )
    or has_column_privilege(
      'authenticated',
      'public.fund_connections',
      'access_token_enc',
      'select'
    )
    or has_column_privilege(
      'authenticated',
      'public.fund_connections',
      'refresh_token_enc',
      'select'
    )
  then
    raise exception 'fund_connections browser credential/DML privilege remains';
  end if;

  if not has_column_privilege(
    'authenticated',
    'public.fund_connections',
    'institution',
    'select'
  ) or not has_column_privilege(
    'authenticated',
    'public.fund_connections',
    'status',
    'select'
  ) or not has_column_privilege(
    'authenticated',
    'public.fund_connections',
    'authority',
    'select'
  ) or not has_column_privilege(
    'authenticated',
    'public.fund_connections',
    'verified_at',
    'select'
  ) then
    raise exception 'safe fund_connections display projection is unavailable';
  end if;

  if has_column_privilege(
    'anon',
    'public.user_passkeys',
    'refresh_token_enc',
    'select'
  ) or has_column_privilege(
    'authenticated',
    'public.user_passkeys',
    'refresh_token_enc',
    'select'
  ) or has_table_privilege(
    'anon',
    'public.user_passkeys',
    'insert'
  ) or has_table_privilege(
    'anon',
    'public.user_passkeys',
    'update'
  ) or has_table_privilege(
    'anon',
    'public.user_passkeys',
    'delete'
  ) or has_table_privilege(
    'authenticated',
    'public.user_passkeys',
    'insert'
  ) or has_table_privilege(
    'authenticated',
    'public.user_passkeys',
    'update'
  ) or has_table_privilege(
    'authenticated',
    'public.user_passkeys',
    'delete'
  ) then
    raise exception 'passkey legacy ciphertext/browser-write privilege remains';
  end if;

  if not has_column_privilege(
    'authenticated',
    'public.user_passkeys',
    'name',
    'select'
  ) or not has_table_privilege(
    'service_role',
    'public.fund_connections',
    'select'
  ) or not has_table_privilege(
    'service_role',
    'public.fund_connections',
    'update'
  ) then
    raise exception 'safe passkey projection or service-role provider access missing';
  end if;
end
$$;

begin;

insert into auth.users (
  id, aud, role, email, created_at, updated_at
) values
  (
    'c1ed0000-0000-4000-8000-000000000001'::uuid,
    'authenticated',
    'authenticated',
    'credential-contract-owner@local.test',
    statement_timestamp(),
    statement_timestamp()
  ),
  (
    'c1ed0000-0000-4000-8000-000000000002'::uuid,
    'authenticated',
    'authenticated',
    'credential-contract-other@local.test',
    statement_timestamp(),
    statement_timestamp()
  );

set local role service_role;

insert into public.fund_connections (
  id,
  user_id,
  provider,
  item_id,
  institution,
  mask,
  status,
  authority,
  verified_at,
  access_token_enc,
  refresh_token_enc
) values
  (
    'c1ed1000-0000-4000-8000-000000000001'::uuid,
    'c1ed0000-0000-4000-8000-000000000001'::uuid,
    'plaid',
    'item-owner',
    'Owner Bank',
    '0001',
    'linked',
    'provider_verified',
    statement_timestamp(),
    'owner-access-ciphertext',
    'owner-refresh-ciphertext'
  ),
  (
    'c1ed1000-0000-4000-8000-000000000002'::uuid,
    'c1ed0000-0000-4000-8000-000000000002'::uuid,
    'plaid',
    'item-other',
    'Other Bank',
    '0002',
    'linked',
    'provider_verified',
    statement_timestamp(),
    'other-access-ciphertext',
    'other-refresh-ciphertext'
  );

do $$
declare
  selected_count integer;
begin
  select count(*) into selected_count
  from public.fund_connections
  where user_id = 'c1ed0000-0000-4000-8000-000000000001'::uuid
    and item_id = 'item-owner'
    and access_token_enc = 'owner-access-ciphertext';
  if selected_count <> 1 then
    raise exception 'service-role provider token insert/select failed';
  end if;

  begin
    insert into public.fund_connections (
      user_id,
      provider,
      item_id,
      status
    ) values (
      'c1ed0000-0000-4000-8000-000000000001'::uuid,
      'plaid',
      'second-active-item',
      'error'
    );
    raise exception 'second non-revoked Plaid Item unexpectedly succeeded';
  exception
    when unique_violation then null;
  end;

  insert into public.fund_connections (
    user_id,
    provider,
    item_id,
    status
  ) values (
    'c1ed0000-0000-4000-8000-000000000001'::uuid,
    'plaid',
    'revoked-history-item',
    'revoked'
  );
end
$$;

reset role;

insert into public.user_passkeys (
  id,
  user_id,
  credential_id,
  credential_public_key,
  name,
  refresh_token_enc
) values (
  'c1ed2000-0000-4000-8000-000000000001'::uuid,
  'c1ed0000-0000-4000-8000-000000000001'::uuid,
  'credential-contract-owner',
  'public-key',
  'Contract passkey',
  'legacy-refresh-ciphertext'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'c1ed0000-0000-4000-8000-000000000001',
  true
);

do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from public.fund_connections
  where institution in ('Owner Bank', 'Other Bank');
  if visible_count <> 1 then
    raise exception 'owner-safe fund connection projection leaked or disappeared';
  end if;

  select count(*) into visible_count
  from public.user_passkeys
  where name = 'Contract passkey';
  if visible_count <> 1 then
    raise exception 'owner-safe passkey list projection failed';
  end if;

  begin
    perform item_id, access_token_enc, refresh_token_enc
    from public.fund_connections;
    raise exception 'authenticated provider credential select unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.user_passkeys
    where id = 'c1ed2000-0000-4000-8000-000000000001'::uuid;
    raise exception 'authenticated passkey delete unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform refresh_token_enc from public.user_passkeys;
    raise exception 'authenticated passkey ciphertext select unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.fund_connections (
      user_id, provider, item_id, status
    ) values (
      'c1ed0000-0000-4000-8000-000000000001'::uuid,
      'plaid',
      'forged-item',
      'linked'
    );
    raise exception 'authenticated fund connection insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.fund_connections
    set status = 'revoked', item_id = 'forged-item'
    where id = 'c1ed1000-0000-4000-8000-000000000001'::uuid;
    raise exception 'authenticated fund connection update unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.fund_connections
    where id = 'c1ed1000-0000-4000-8000-000000000001'::uuid;
    raise exception 'authenticated fund connection delete unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

reset role;

set local role anon;

do $$
begin
  begin
    insert into public.user_passkeys (
      user_id,
      credential_id,
      credential_public_key
    ) values (
      'c1ed0000-0000-4000-8000-000000000001'::uuid,
      'anon-forged-passkey',
      'anon-forged-public-key'
    );
    raise exception 'anon passkey insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.user_passkeys
    set name = 'anon-forged-name';
    raise exception 'anon passkey update unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.user_passkeys;
    raise exception 'anon passkey delete unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

reset role;
set local role service_role;

do $$
declare
  affected integer;
begin
  update public.fund_connections
  set status = 'revoked',
      authority = 'legacy_unknown',
      verified_at = null,
      access_token_enc = null,
      refresh_token_enc = null
  where user_id = 'c1ed0000-0000-4000-8000-000000000001'::uuid
    and id = 'c1ed1000-0000-4000-8000-000000000001'::uuid;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'explicitly owner-scoped service mutation failed';
  end if;
end
$$;

rollback;

reset statement_timeout;
