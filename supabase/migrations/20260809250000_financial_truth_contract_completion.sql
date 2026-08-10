-- FIN-003 / FIN-004 contract completion. This migration is append-only: all
-- preceding financial-truth migrations have already been applied remotely.

begin;

-- Provider credentials and Item identifiers are server-only. Authenticated
-- clients retain owner-filtered display metadata and no mutation privilege.
drop policy if exists "fund_connections_insert_own" on public.fund_connections;
drop policy if exists "fund_connections_update_own" on public.fund_connections;
drop policy if exists "fund_connections_delete_own" on public.fund_connections;
revoke all on table public.fund_connections from authenticated;
grant select (
  id, user_id, provider, institution, mask, status, authority, verified_at,
  action_required, provider_event_at, created_at, updated_at
) on table public.fund_connections to authenticated;

-- Preserve append-only history during ordinary operations while allowing the
-- declared auth.users cascade to complete account deletion.
create or replace function public.reject_net_worth_revision_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.pg_trigger_depth() = 2
     and not exists (select 1 from auth.users where id = old.user_id) then
    return old;
  end if;
  raise exception 'net-worth snapshot revisions are append-only'
    using errcode = '42501';
end;
$$;
revoke all on function public.reject_net_worth_revision_mutation()
  from public, anon, authenticated;
alter table public.net_worth_snapshot_revisions
  drop constraint if exists net_worth_snapshot_revisions_snapshot_id_fkey,
  add constraint net_worth_snapshot_revisions_snapshot_id_fkey
    foreign key (snapshot_id) references public.net_worth_snapshots(id) on delete cascade;

-- The application supports one active Plaid Item per owner. Abort rather than
-- choosing a winner if historical state already violates the contract.
do $$
begin
  if exists (
    select 1
    from public.fund_connections
    where provider = 'plaid' and status <> 'revoked'
    group by user_id
    having count(*) > 1
  ) then
    raise exception 'active Plaid Item duplicates require quarantine before contract migration'
      using errcode = '23514';
  end if;
end;
$$;
create unique index if not exists fund_connections_one_active_plaid_item_uidx
  on public.fund_connections (user_id)
  where provider = 'plaid' and status <> 'revoked';

-- Match the application adapter's canonical Public/Massive US-equity grammar.
do $$
begin
  if exists (
    select 1 from public.fund_order_intents
    where length(symbol) > 12
       or symbol !~ '^[A-Z][A-Z0-9]{0,9}([.-][A-Z0-9]{1,2})?$'
  ) then
    raise exception 'invalid immutable order-intent symbols require quarantine before contract migration'
      using errcode = '23514';
  end if;
end;
$$;
alter table public.fund_order_intents
  drop constraint if exists fund_order_intents_symbol_check,
  drop constraint if exists fund_order_intents_symbol_contract,
  add constraint fund_order_intents_symbol_contract check (
    length(symbol) <= 12
    and symbol ~ '^[A-Z][A-Z0-9]{0,9}([.-][A-Z0-9]{1,2})?$'
  );

-- Replace one complete detected-recurring generation atomically. Manual rows
-- are never touched; detected rows absent from the new generation are retired.
create or replace function public.reconcile_fund_recurring_generation(
  p_user_id uuid,
  p_source_generations jsonb,
  p_source_generation_hash text,
  p_rows jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null
     or jsonb_typeof(p_source_generations) <> 'array'
     or jsonb_array_length(p_source_generations) = 0
     or p_source_generation_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 1000 then
    raise exception 'invalid recurring generation' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as row(value)
    where nullif(btrim(row.value->>'merchant_name'), '') is null
       or public.fund_currency_minor_factor(row.value->>'currency') is null
       or (row.value->>'cadence') not in ('weekly','biweekly','monthly','quarterly','annual')
       or (row.value->>'expected_amount') is null
       or (row.value->>'last_seen_date') is null
       or (row.value->>'next_expected_date') is null
  ) then
    raise exception 'invalid recurring row' using errcode = '22023';
  end if;

  insert into public.fund_recurring_transactions (
    user_id, merchant_name, expected_amount, currency, cadence,
    last_seen_date, next_expected_date, source, source_generations,
    source_generation_hash, status, updated_at
  )
  select
    p_user_id,
    btrim(row.value->>'merchant_name'),
    (row.value->>'expected_amount')::numeric,
    row.value->>'currency',
    row.value->>'cadence',
    (row.value->>'last_seen_date')::date,
    (row.value->>'next_expected_date')::date,
    'detected',
    p_source_generations,
    p_source_generation_hash,
    'active',
    now()
  from jsonb_array_elements(p_rows) as row(value)
  on conflict (user_id, merchant_name, currency, source) do update set
    expected_amount = excluded.expected_amount,
    cadence = excluded.cadence,
    last_seen_date = excluded.last_seen_date,
    next_expected_date = excluded.next_expected_date,
    source_generations = excluded.source_generations,
    source_generation_hash = excluded.source_generation_hash,
    status = 'active',
    updated_at = now();

  update public.fund_recurring_transactions existing
  set status = 'cancelled',
      source_generations = p_source_generations,
      source_generation_hash = p_source_generation_hash,
      updated_at = now()
  where existing.user_id = p_user_id
    and existing.source = 'detected'
    and existing.status <> 'cancelled'
    and not exists (
      select 1
      from jsonb_array_elements(p_rows) as row(value)
      where btrim(row.value->>'merchant_name') = existing.merchant_name
        and row.value->>'currency' = existing.currency
    );
  return true;
end;
$$;
revoke all on function public.reconcile_fund_recurring_generation(uuid,jsonb,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.reconcile_fund_recurring_generation(uuid,jsonb,text,jsonb)
  to service_role;

-- Durable keyset continuation prevents a fixed first page of Plaid connections
-- from starving later owners across cron invocations.
create table if not exists public.finance_cron_cursors (
  job_key text primary key,
  last_connection_id uuid,
  last_user_id uuid,
  updated_at timestamptz not null default now(),
  check (job_key in ('finance-daily-plaid-sync', 'finance-daily-user-jobs'))
);
alter table public.finance_cron_cursors
  add column if not exists last_user_id uuid;
alter table public.finance_cron_cursors
  drop constraint if exists finance_cron_cursors_job_key_check;
alter table public.finance_cron_cursors
  add constraint finance_cron_cursors_job_key_check
  check (job_key in ('finance-daily-plaid-sync', 'finance-daily-user-jobs'));
alter table public.finance_cron_cursors enable row level security;
revoke all on table public.finance_cron_cursors from public, anon, authenticated;
grant select, insert, update on table public.finance_cron_cursors to service_role;

create or replace function public.claim_finance_cron_connections(p_limit integer)
returns table(id uuid, user_id uuid, access_token_enc text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor uuid;
  v_ids uuid[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid finance cron connection claim limit' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('finance-daily-plaid-sync', 0)
  );
  insert into public.finance_cron_cursors(job_key)
  values ('finance-daily-plaid-sync')
  on conflict (job_key) do nothing;
  select cursor.last_connection_id into v_cursor
  from public.finance_cron_cursors cursor
  where cursor.job_key = 'finance-daily-plaid-sync'
  for update;

  select pg_catalog.array_agg(candidate.id order by candidate.ordinal)
  into v_ids
  from (
    select connection.id,
      pg_catalog.row_number() over (
        order by
          case when v_cursor is null or connection.id > v_cursor then 0 else 1 end,
          connection.id
      ) as ordinal
    from public.fund_connections connection
    where connection.provider = 'plaid'
      and connection.status = 'linked'
      and connection.authority = 'provider_verified'
    order by
      case when v_cursor is null or connection.id > v_cursor then 0 else 1 end,
      connection.id
    limit p_limit
  ) candidate;

  if coalesce(pg_catalog.array_length(v_ids, 1), 0) > 0 then
    update public.finance_cron_cursors cursor
    set last_connection_id = v_ids[pg_catalog.array_length(v_ids, 1)],
        updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-plaid-sync';
  end if;

  return query
  select connection.id, connection.user_id, connection.access_token_enc
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) with ordinality claimed(id, ordinal)
  join public.fund_connections connection on connection.id = claimed.id
  order by claimed.ordinal;
end;
$$;
revoke all on function public.claim_finance_cron_connections(integer)
  from public, anon, authenticated;
grant execute on function public.claim_finance_cron_connections(integer)
  to service_role;

create or replace function public.claim_finance_cron_users(p_limit integer)
returns table(user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor uuid;
  v_ids uuid[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception 'invalid finance cron user claim limit' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('finance-daily-user-jobs', 0)
  );
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
  select pg_catalog.array_agg(candidate.user_id order by candidate.ordinal)
  into v_ids
  from (
    select discovered.user_id,
      pg_catalog.row_number() over (
        order by
          case when v_cursor is null or discovered.user_id > v_cursor then 0 else 1 end,
          discovered.user_id
      ) as ordinal
    from discovered
    order by
      case when v_cursor is null or discovered.user_id > v_cursor then 0 else 1 end,
      discovered.user_id
    limit p_limit
  ) candidate;

  if coalesce(pg_catalog.array_length(v_ids, 1), 0) > 0 then
    update public.finance_cron_cursors cursor
    set last_user_id = v_ids[pg_catalog.array_length(v_ids, 1)],
        updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-user-jobs';
  end if;

  return query
  select claimed.id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) with ordinality claimed(id, ordinal)
  order by claimed.ordinal;
end;
$$;
revoke all on function public.claim_finance_cron_users(integer)
  from public, anon, authenticated;
grant execute on function public.claim_finance_cron_users(integer)
  to service_role;

commit;
