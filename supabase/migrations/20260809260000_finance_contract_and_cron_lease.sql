-- FIN-003 / FIN-004 final contract and durable finance-cron ownership.
-- Append-only follow-up: 250000 may already have been applied by preview or
-- migration evidence, so its authored bytes remain immutable.

begin;

-- The compatible application records immutable order intents only. Remove the
-- expansion-era browser path for legacy transactions; verified executions are
-- materialized only by the service-only receipt RPC.
drop policy if exists "fund_transactions_insert_own" on public.fund_transactions;
drop policy if exists "fund_transactions_update_own" on public.fund_transactions;
drop policy if exists "fund_transactions_delete_own" on public.fund_transactions;
revoke insert, update, delete, truncate on table public.fund_transactions
  from authenticated, service_role;
grant select on table public.fund_transactions to authenticated, service_role;

-- The lineage-aware identity is already present from the expansion migration.
-- Remove the legacy merchant-only arbiter so manual/detected and multi-currency
-- rows can coexist without aborting an atomic generation.
create unique index if not exists fund_recurring_transactions_identity_uidx
  on public.fund_recurring_transactions (user_id, merchant_name, currency, source);
alter table public.fund_recurring_transactions
  drop constraint if exists fund_recurring_transactions_user_merchant_uniq;

-- Remove the expansion-era lineage-less detected-row compatibility branch.
-- Authenticated owners may still author manual rows; detected facts require a
-- currently complete transaction generation with the exact lineage hash.
create or replace function public.guard_fund_recurring_transaction_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  coverage_available boolean;
  coverage_hash text;
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.source := 'manual';
      new.source_generations := null;
      new.source_generation_hash := null;
      return new;
    end if;
    if tg_op = 'DELETE' then
      if old.source = 'detected' then
        raise exception 'detected recurring facts are server-managed'
          using errcode = '42501';
      end if;
      return old;
    end if;
    if old.source = 'detected' then
      if new.user_id is distinct from old.user_id
        or new.merchant_name is distinct from old.merchant_name
        or new.category is distinct from old.category
        or new.expected_amount is distinct from old.expected_amount
        or new.currency is distinct from old.currency
        or new.cadence is distinct from old.cadence
        or new.next_expected_date is distinct from old.next_expected_date
        or new.last_seen_date is distinct from old.last_seen_date
        or new.source is distinct from old.source
        or new.source_generations is distinct from old.source_generations
        or new.source_generation_hash is distinct from old.source_generation_hash
        or new.created_at is distinct from old.created_at then
        raise exception 'detected recurring facts are server-managed'
          using errcode = '42501';
      end if;
      return new;
    end if;
    new.source := 'manual';
    new.source_generations := null;
    new.source_generation_hash := null;
    return new;
  end if;

  if tg_op <> 'DELETE' and new.source = 'detected' then
    if new.source_generations is null or new.source_generation_hash is null then
      raise exception 'detected recurring lineage is required'
        using errcode = '23514';
    end if;
    select verified.available, verified.lineage_hash
    into coverage_available, coverage_hash
    from public.check_fund_transaction_history_coverage(
      new.user_id,
      (current_date - 90)::date,
      current_date
    ) verified;
    if coverage_available is distinct from true
      or new.source_generation_hash is distinct from coverage_hash then
      raise exception 'detected recurring lineage is not current and complete'
        using errcode = '23514';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.guard_fund_recurring_transaction_authority()
  from public, anon, authenticated;

-- One durable lease covers both cron phases. A route must own the unguessable
-- run token before it can claim or acknowledge any work. Expiry recovers a
-- crashed invocation; the route's 50-second budget is strictly below the
-- permitted 120-second lease used by the application.
create table if not exists public.finance_cron_run_leases (
  job_key text primary key check (job_key = 'finance-daily'),
  run_id uuid not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.finance_cron_run_leases enable row level security;
revoke all on table public.finance_cron_run_leases from public, anon, authenticated, service_role;

create table if not exists public.finance_cron_run_claims (
  phase text not null check (phase in ('connections', 'users')),
  item_id uuid not null,
  run_id uuid not null,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (phase, item_id)
);
alter table public.finance_cron_run_claims enable row level security;
revoke all on table public.finance_cron_run_claims from public, anon, authenticated, service_role;

create or replace function public.acquire_finance_cron_run(
  p_run_id uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acquired boolean := false;
begin
  if p_run_id is null or p_lease_seconds is null
     or p_lease_seconds < 60 or p_lease_seconds > 300 then
    raise exception 'invalid finance cron lease' using errcode = '22023';
  end if;

  insert into public.finance_cron_run_leases (
    job_key, run_id, lease_expires_at, created_at, updated_at
  ) values (
    'finance-daily', p_run_id,
    pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
    pg_catalog.now(), pg_catalog.now()
  )
  on conflict (job_key) do update
  set run_id = excluded.run_id,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = pg_catalog.now()
  where public.finance_cron_run_leases.lease_expires_at <= pg_catalog.now()
     or public.finance_cron_run_leases.run_id = excluded.run_id
  returning true into v_acquired;

  if coalesce(v_acquired, false) then
    delete from public.finance_cron_run_claims claim
    where claim.run_id <> p_run_id;
  end if;
  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.claim_finance_cron_connections(
  p_run_id uuid,
  p_limit integer
)
returns table(id uuid, user_id uuid, access_token_enc text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor uuid;
  v_ids uuid[];
begin
  if p_run_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid finance cron connection claim' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.finance_cron_run_leases lease
    where lease.job_key = 'finance-daily'
      and lease.run_id = p_run_id
      and lease.lease_expires_at > pg_catalog.now()
  ) then
    raise exception 'finance cron lease unavailable' using errcode = '55000';
  end if;

  insert into public.finance_cron_cursors(job_key)
  values ('finance-daily-plaid-sync')
  on conflict (job_key) do nothing;
  select cursor.last_connection_id into v_cursor
  from public.finance_cron_cursors cursor
  where cursor.job_key = 'finance-daily-plaid-sync'
  for update;

  select pg_catalog.array_agg(connection.id order by connection.id)
  into v_ids
  from (
    select candidate.id
    from public.fund_connections candidate
    where candidate.provider = 'plaid'
      and candidate.status = 'linked'
      and candidate.authority = 'provider_verified'
      and (v_cursor is null or candidate.id > v_cursor)
    order by candidate.id
    limit p_limit
  ) connection;

  if coalesce(pg_catalog.array_length(v_ids, 1), 0) = 0 and v_cursor is not null then
    update public.finance_cron_cursors cursor
    set last_connection_id = null,
        updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-plaid-sync';
    select pg_catalog.array_agg(connection.id order by connection.id)
    into v_ids
    from (
      select candidate.id
      from public.fund_connections candidate
      where candidate.provider = 'plaid'
        and candidate.status = 'linked'
        and candidate.authority = 'provider_verified'
      order by candidate.id
      limit p_limit
    ) connection;
  end if;

  insert into public.finance_cron_run_claims(phase, item_id, run_id)
  select 'connections', claimed.id, p_run_id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) claimed(id)
  on conflict (phase, item_id) do update
  set run_id = excluded.run_id,
      claimed_at = pg_catalog.now(),
      completed_at = null;

  return query
  select connection.id, connection.user_id, connection.access_token_enc
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) with ordinality claimed(id, ordinal)
  join public.fund_connections connection on connection.id = claimed.id
  order by claimed.ordinal;
end;
$$;

create or replace function public.ack_finance_cron_connection(
  p_run_id uuid,
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.finance_cron_run_leases lease
    join public.finance_cron_run_claims claim
      on claim.run_id = lease.run_id
     and claim.phase = 'connections'
     and claim.item_id = p_connection_id
    where lease.job_key = 'finance-daily'
      and lease.run_id = p_run_id
      and lease.lease_expires_at > pg_catalog.now()
  ) then
    return false;
  end if;
  update public.finance_cron_cursors cursor
  set last_connection_id = p_connection_id,
      updated_at = pg_catalog.now()
  where cursor.job_key = 'finance-daily-plaid-sync';
  update public.finance_cron_run_claims claim
  set completed_at = pg_catalog.now()
  where claim.phase = 'connections'
    and claim.item_id = p_connection_id
    and claim.run_id = p_run_id;
  return true;
end;
$$;

create or replace function public.claim_finance_cron_users(
  p_run_id uuid,
  p_limit integer
)
returns table(user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor uuid;
  v_ids uuid[];
begin
  if p_run_id is null or p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception 'invalid finance cron user claim' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.finance_cron_run_leases lease
    where lease.job_key = 'finance-daily'
      and lease.run_id = p_run_id
      and lease.lease_expires_at > pg_catalog.now()
  ) then
    raise exception 'finance cron lease unavailable' using errcode = '55000';
  end if;

  insert into public.finance_cron_cursors(job_key)
  values ('finance-daily-user-jobs')
  on conflict (job_key) do nothing;
  select cursor.last_user_id into v_cursor
  from public.finance_cron_cursors cursor
  where cursor.job_key = 'finance-daily-user-jobs'
  for update;

  with discovered as (
    select connection.user_id from public.fund_connections connection where connection.status = 'linked' and connection.authority = 'provider_verified'
    union select holding.user_id from public.fund_holdings holding
    union select liability.user_id from public.fund_liabilities liability
    union select txn.user_id from public.fund_bank_transactions txn
    union select budget.user_id from public.fund_category_budgets budget
    union select recurring.user_id from public.fund_recurring_transactions recurring
  )
  select pg_catalog.array_agg(candidate.user_id order by candidate.user_id)
  into v_ids
  from (
    select discovered.user_id
    from discovered
    where v_cursor is null or discovered.user_id > v_cursor
    order by discovered.user_id
    limit p_limit
  ) candidate;

  if coalesce(pg_catalog.array_length(v_ids, 1), 0) = 0 and v_cursor is not null then
    update public.finance_cron_cursors cursor
    set last_user_id = null,
        updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-user-jobs';
    with discovered as (
      select connection.user_id from public.fund_connections connection where connection.status = 'linked' and connection.authority = 'provider_verified'
      union select holding.user_id from public.fund_holdings holding
      union select liability.user_id from public.fund_liabilities liability
      union select txn.user_id from public.fund_bank_transactions txn
      union select budget.user_id from public.fund_category_budgets budget
      union select recurring.user_id from public.fund_recurring_transactions recurring
    )
    select pg_catalog.array_agg(candidate.user_id order by candidate.user_id)
    into v_ids
    from (
      select discovered.user_id
      from discovered
      order by discovered.user_id
      limit p_limit
    ) candidate;
  end if;

  insert into public.finance_cron_run_claims(phase, item_id, run_id)
  select 'users', claimed.id, p_run_id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) claimed(id)
  on conflict (phase, item_id) do update
  set run_id = excluded.run_id,
      claimed_at = pg_catalog.now(),
      completed_at = null;

  return query
  select claimed.id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) with ordinality claimed(id, ordinal)
  order by claimed.ordinal;
end;
$$;

create or replace function public.ack_finance_cron_user(
  p_run_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.finance_cron_run_leases lease
    join public.finance_cron_run_claims claim
      on claim.run_id = lease.run_id
     and claim.phase = 'users'
     and claim.item_id = p_user_id
    where lease.job_key = 'finance-daily'
      and lease.run_id = p_run_id
      and lease.lease_expires_at > pg_catalog.now()
  ) then
    return false;
  end if;
  update public.finance_cron_cursors cursor
  set last_user_id = p_user_id,
      updated_at = pg_catalog.now()
  where cursor.job_key = 'finance-daily-user-jobs';
  update public.finance_cron_run_claims claim
  set completed_at = pg_catalog.now()
  where claim.phase = 'users'
    and claim.item_id = p_user_id
    and claim.run_id = p_run_id;
  return true;
end;
$$;

create or replace function public.release_finance_cron_run(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released boolean := false;
begin
  if p_run_id is null then return false; end if;
  delete from public.finance_cron_run_leases lease
  where lease.job_key = 'finance-daily'
    and lease.run_id = p_run_id
  returning true into v_released;
  if coalesce(v_released, false) then
    delete from public.finance_cron_run_claims claim
    where claim.run_id = p_run_id;
  end if;
  return coalesce(v_released, false);
end;
$$;

-- The cursor-only overloads are unsafe once the application is lease-aware.
revoke execute on function public.claim_finance_cron_connections(integer) from service_role;
revoke execute on function public.claim_finance_cron_users(integer) from service_role;

revoke all on function public.acquire_finance_cron_run(uuid,integer) from public, anon, authenticated;
revoke all on function public.claim_finance_cron_connections(uuid,integer) from public, anon, authenticated;
revoke all on function public.ack_finance_cron_connection(uuid,uuid) from public, anon, authenticated;
revoke all on function public.claim_finance_cron_users(uuid,integer) from public, anon, authenticated;
revoke all on function public.ack_finance_cron_user(uuid,uuid) from public, anon, authenticated;
revoke all on function public.release_finance_cron_run(uuid) from public, anon, authenticated;
grant execute on function public.acquire_finance_cron_run(uuid,integer) to service_role;
grant execute on function public.claim_finance_cron_connections(uuid,integer) to service_role;
grant execute on function public.ack_finance_cron_connection(uuid,uuid) to service_role;
grant execute on function public.claim_finance_cron_users(uuid,integer) to service_role;
grant execute on function public.ack_finance_cron_user(uuid,uuid) to service_role;
grant execute on function public.release_finance_cron_run(uuid) to service_role;

commit;
