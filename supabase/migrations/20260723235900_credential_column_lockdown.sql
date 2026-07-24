-- Lock provider credentials and provider-owned identity fields behind trusted
-- server routes. Owner RLS alone is not sufficient for encrypted secrets:
-- authenticated browser clients must not be able to read ciphertext, forge a
-- provider locator/status, or delete a row without provider unlink cleanup.

begin;

alter table public.fund_connections
  add column if not exists authority text not null default 'legacy_unknown',
  add column if not exists verified_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.fund_connections'::regclass
      and conname = 'fund_connections_authority_check'
  ) then
    alter table public.fund_connections
      add constraint fund_connections_authority_check
      check (authority in ('legacy_unknown', 'provider_verified'));
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.fund_connections'::regclass
      and conname = 'fund_connections_verified_at_check'
  ) then
    alter table public.fund_connections
      add constraint fund_connections_verified_at_check
      check (
        (authority = 'provider_verified' and verified_at is not null)
        or (authority = 'legacy_unknown' and verified_at is null)
      );
  end if;
end
$$;

drop policy if exists "fund_connections_select_own" on public.fund_connections;
drop policy if exists "fund_connections_insert_own" on public.fund_connections;
drop policy if exists "fund_connections_update_own" on public.fund_connections;
drop policy if exists "fund_connections_delete_own" on public.fund_connections;

create policy "fund_connections_select_own"
  on public.fund_connections
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

do $$
begin
  if exists (
    select 1
    from public.fund_connections
    where provider = 'plaid'
      and status <> 'revoked'
    group by user_id
    having count(*) > 1
  ) then
    raise exception
      'fund_connections contains duplicate linked Plaid Items; reconcile before applying credential lockdown'
      using errcode = '23505';
  end if;
end
$$;

create unique index if not exists fund_connections_one_active_plaid_per_user
  on public.fund_connections (user_id)
  where provider = 'plaid' and status <> 'revoked';

revoke all privileges on table public.fund_connections from anon, authenticated;
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
) on table public.fund_connections to authenticated;

comment on column public.fund_connections.item_id is
  'Server-only provider Item locator; never browser-readable or browser-writable.';
comment on column public.fund_connections.access_token_enc is
  'Server-only encrypted provider access token.';
comment on column public.fund_connections.refresh_token_enc is
  'Server-only encrypted provider refresh token.';

-- The legacy passkey refresh-token ciphertext is retained non-destructively,
-- but no browser role may read or mutate it. Passkey lifecycle writes already
-- run through service-role atomic RPCs.
revoke all privileges on table public.user_passkeys from anon, authenticated;
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
) on table public.user_passkeys to authenticated;

comment on column public.user_passkeys.refresh_token_enc is
  'Deprecated retained ciphertext; server-only and excluded from authenticated column grants.';

commit;
