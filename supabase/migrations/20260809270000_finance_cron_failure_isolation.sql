-- FIN-003 / FIN-004 follow-up: isolate poison cron items without losing retry.
-- A failed item advances the phase cursor only after a token-bound failure
-- record is committed. It is retried with bounded backoff and quarantined
-- after three consecutive failures; successful acknowledgement clears the
-- failure record. This prevents one tenant from starving later tenants.

begin;

create table if not exists public.finance_cron_item_failures (
  phase text not null check (phase in ('connections', 'users')),
  item_id uuid not null,
  attempt_count integer not null default 1 check (attempt_count between 1 and 3),
  last_error_code text not null check (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  next_attempt_at timestamptz,
  quarantined_at timestamptz,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  primary key (phase, item_id),
  check (
    (attempt_count < 3 and next_attempt_at is not null and quarantined_at is null)
    or (attempt_count = 3 and next_attempt_at is null and quarantined_at is not null)
  )
);
alter table public.finance_cron_item_failures enable row level security;
revoke all on table public.finance_cron_item_failures
  from public, anon, authenticated, service_role;
-- Cursor state is owned exclusively by the lease-bound SECURITY DEFINER RPCs.
-- The expansion migration granted service_role direct DML; retire that bypass.
revoke all on table public.finance_cron_cursors
  from service_role;

-- Use wall-clock lease expiry and serialize takeover on the lease row. A
-- claimant holding this row may finish its database mutation, but a successor
-- cannot acquire ownership concurrently.
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
  insert into public.finance_cron_run_leases(
    job_key, run_id, lease_expires_at, created_at, updated_at
  ) values (
    'finance-daily', p_run_id,
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  )
  on conflict (job_key) do update
  set run_id = excluded.run_id,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = pg_catalog.clock_timestamp()
  where public.finance_cron_run_leases.lease_expires_at <= pg_catalog.clock_timestamp()
     or public.finance_cron_run_leases.run_id = excluded.run_id
  returning true into v_acquired;
  if coalesce(v_acquired, false) then
    delete from public.finance_cron_run_claims claim where claim.run_id <> p_run_id;
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
  v_owner uuid;
  v_expiry timestamptz;
begin
  if p_run_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid finance cron connection claim' using errcode = '22023';
  end if;
  select lease.run_id, lease.lease_expires_at into v_owner, v_expiry
  from public.finance_cron_run_leases lease
  where lease.job_key = 'finance-daily'
  for update;
  if v_owner is distinct from p_run_id
    or v_expiry <= pg_catalog.clock_timestamp() then
    raise exception 'finance cron lease unavailable' using errcode = '55000';
  end if;

  insert into public.finance_cron_cursors(job_key)
  values ('finance-daily-plaid-sync')
  on conflict (job_key) do nothing;
  select cursor.last_connection_id into v_cursor
  from public.finance_cron_cursors cursor
  where cursor.job_key = 'finance-daily-plaid-sync'
  for update;

  with eligible as (
    select connection.id, 0 as priority
    from public.fund_connections connection
    join public.finance_cron_item_failures failure
      on failure.phase = 'connections' and failure.item_id = connection.id
    where connection.provider = 'plaid'
      and connection.status = 'linked'
      and connection.authority = 'provider_verified'
      and failure.quarantined_at is null
      and failure.next_attempt_at <= pg_catalog.now()
    union all
    select connection.id, 1 as priority
    from public.fund_connections connection
    where connection.provider = 'plaid'
      and connection.status = 'linked'
      and connection.authority = 'provider_verified'
      and (v_cursor is null or connection.id > v_cursor)
      and not exists (
        select 1 from public.finance_cron_item_failures failure
        where failure.phase = 'connections' and failure.item_id = connection.id
      )
  )
  select pg_catalog.array_agg(candidate.id order by candidate.priority, candidate.id)
  into v_ids
  from (
    select eligible.id, min(eligible.priority) as priority
    from eligible
    group by eligible.id
    order by min(eligible.priority), eligible.id
    limit p_limit
  ) candidate;

  if coalesce(pg_catalog.array_length(v_ids, 1), 0) = 0 and v_cursor is not null then
    update public.finance_cron_cursors cursor
    set last_connection_id = null, updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-plaid-sync';
    with eligible as (
      select connection.id, 0 as priority
      from public.fund_connections connection
      join public.finance_cron_item_failures failure
        on failure.phase = 'connections' and failure.item_id = connection.id
      where connection.provider = 'plaid'
        and connection.status = 'linked'
        and connection.authority = 'provider_verified'
        and failure.quarantined_at is null
        and failure.next_attempt_at <= pg_catalog.now()
      union all
      select connection.id, 1 as priority
      from public.fund_connections connection
      where connection.provider = 'plaid'
        and connection.status = 'linked'
        and connection.authority = 'provider_verified'
        and not exists (
          select 1 from public.finance_cron_item_failures failure
          where failure.phase = 'connections' and failure.item_id = connection.id
        )
    )
    select pg_catalog.array_agg(candidate.id order by candidate.priority, candidate.id)
    into v_ids
    from (
      select eligible.id, min(eligible.priority) as priority
      from eligible
      group by eligible.id
      order by min(eligible.priority), eligible.id
      limit p_limit
    ) candidate;
  end if;

  if v_expiry <= pg_catalog.clock_timestamp() then
    raise exception 'finance cron lease expired during connection claim' using errcode = '55000';
  end if;

  insert into public.finance_cron_run_claims(phase, item_id, run_id)
  select 'connections', claimed.id, p_run_id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) claimed(id)
  on conflict (phase, item_id) do update
  set run_id = excluded.run_id, claimed_at = pg_catalog.now(), completed_at = null;

  return query
  select connection.id, connection.user_id, connection.access_token_enc
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) with ordinality claimed(id, ordinal)
  join public.fund_connections connection on connection.id = claimed.id
  order by claimed.ordinal;
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
  v_owner uuid;
  v_expiry timestamptz;
begin
  if p_run_id is null or p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception 'invalid finance cron user claim' using errcode = '22023';
  end if;
  select lease.run_id, lease.lease_expires_at into v_owner, v_expiry
  from public.finance_cron_run_leases lease
  where lease.job_key = 'finance-daily'
  for update;
  if v_owner is distinct from p_run_id
    or v_expiry <= pg_catalog.clock_timestamp() then
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
  ), eligible as (
    select discovered.user_id, 0 as priority
    from discovered
    join public.finance_cron_item_failures failure
      on failure.phase = 'users' and failure.item_id = discovered.user_id
    where failure.quarantined_at is null and failure.next_attempt_at <= pg_catalog.now()
    union all
    select discovered.user_id, 1 as priority
    from discovered
    where (v_cursor is null or discovered.user_id > v_cursor)
      and not exists (
        select 1 from public.finance_cron_item_failures failure
        where failure.phase = 'users' and failure.item_id = discovered.user_id
      )
  )
  select pg_catalog.array_agg(candidate.user_id order by candidate.priority, candidate.user_id)
  into v_ids
  from (
    select eligible.user_id, min(eligible.priority) as priority
    from eligible
    group by eligible.user_id
    order by min(eligible.priority), eligible.user_id
    limit p_limit
  ) candidate;

  if coalesce(pg_catalog.array_length(v_ids, 1), 0) = 0 and v_cursor is not null then
    update public.finance_cron_cursors cursor
    set last_user_id = null, updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-user-jobs';
    with discovered as (
      select connection.user_id from public.fund_connections connection where connection.status = 'linked' and connection.authority = 'provider_verified'
      union select holding.user_id from public.fund_holdings holding
      union select liability.user_id from public.fund_liabilities liability
      union select txn.user_id from public.fund_bank_transactions txn
      union select budget.user_id from public.fund_category_budgets budget
      union select recurring.user_id from public.fund_recurring_transactions recurring
    ), eligible as (
      select discovered.user_id, 0 as priority
      from discovered
      join public.finance_cron_item_failures failure
        on failure.phase = 'users' and failure.item_id = discovered.user_id
      where failure.quarantined_at is null and failure.next_attempt_at <= pg_catalog.now()
      union all
      select discovered.user_id, 1 as priority
      from discovered
      where not exists (
        select 1 from public.finance_cron_item_failures failure
        where failure.phase = 'users' and failure.item_id = discovered.user_id
      )
    )
    select pg_catalog.array_agg(candidate.user_id order by candidate.priority, candidate.user_id)
    into v_ids
    from (
      select eligible.user_id, min(eligible.priority) as priority
      from eligible
      group by eligible.user_id
      order by min(eligible.priority), eligible.user_id
      limit p_limit
    ) candidate;
  end if;

  if v_expiry <= pg_catalog.clock_timestamp() then
    raise exception 'finance cron lease expired during user claim' using errcode = '55000';
  end if;

  insert into public.finance_cron_run_claims(phase, item_id, run_id)
  select 'users', claimed.id, p_run_id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) claimed(id)
  on conflict (phase, item_id) do update
  set run_id = excluded.run_id, claimed_at = pg_catalog.now(), completed_at = null;

  return query
  select claimed.id
  from pg_catalog.unnest(coalesce(v_ids, array[]::uuid[])) with ordinality claimed(id, ordinal)
  order by claimed.ordinal;
end;
$$;

create or replace function public.ack_finance_cron_connection(p_run_id uuid, p_connection_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_expiry timestamptz;
  v_rows integer;
begin
  select lease.run_id, lease.lease_expires_at into v_owner, v_expiry
  from public.finance_cron_run_leases lease
  where lease.job_key = 'finance-daily' for update;
  if v_owner is distinct from p_run_id
    or v_expiry <= pg_catalog.clock_timestamp() then return false; end if;
  perform 1 from public.finance_cron_run_claims claim
  where claim.run_id = p_run_id and claim.phase = 'connections'
    and claim.item_id = p_connection_id and claim.completed_at is null
  for update;
  if not found then return false; end if;
  perform 1 from public.finance_cron_cursors cursor
  where cursor.job_key = 'finance-daily-plaid-sync' for update;
  if not found or v_expiry <= pg_catalog.clock_timestamp() then return false; end if;
  update public.finance_cron_cursors cursor
  set last_connection_id = case when cursor.last_connection_id is null or p_connection_id > cursor.last_connection_id then p_connection_id else cursor.last_connection_id end,
      updated_at = pg_catalog.now()
  where cursor.job_key = 'finance-daily-plaid-sync';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'finance cron connection cursor mutation failed' using errcode = '55000'; end if;
  delete from public.finance_cron_item_failures failure
  where failure.phase = 'connections' and failure.item_id = p_connection_id;
  update public.finance_cron_run_claims claim set completed_at = pg_catalog.now()
  where claim.phase = 'connections' and claim.item_id = p_connection_id
    and claim.run_id = p_run_id and claim.completed_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'finance cron connection claim mutation failed' using errcode = '55000'; end if;
  return true;
end;
$$;

create or replace function public.ack_finance_cron_user(p_run_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_expiry timestamptz;
  v_rows integer;
begin
  select lease.run_id, lease.lease_expires_at into v_owner, v_expiry
  from public.finance_cron_run_leases lease
  where lease.job_key = 'finance-daily' for update;
  if v_owner is distinct from p_run_id
    or v_expiry <= pg_catalog.clock_timestamp() then return false; end if;
  perform 1 from public.finance_cron_run_claims claim
  where claim.run_id = p_run_id and claim.phase = 'users'
    and claim.item_id = p_user_id and claim.completed_at is null
  for update;
  if not found then return false; end if;
  perform 1 from public.finance_cron_cursors cursor
  where cursor.job_key = 'finance-daily-user-jobs' for update;
  if not found or v_expiry <= pg_catalog.clock_timestamp() then return false; end if;
  update public.finance_cron_cursors cursor
  set last_user_id = case when cursor.last_user_id is null or p_user_id > cursor.last_user_id then p_user_id else cursor.last_user_id end,
      updated_at = pg_catalog.now()
  where cursor.job_key = 'finance-daily-user-jobs';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'finance cron user cursor mutation failed' using errcode = '55000'; end if;
  delete from public.finance_cron_item_failures failure
  where failure.phase = 'users' and failure.item_id = p_user_id;
  update public.finance_cron_run_claims claim set completed_at = pg_catalog.now()
  where claim.phase = 'users' and claim.item_id = p_user_id
    and claim.run_id = p_run_id and claim.completed_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'finance cron user claim mutation failed' using errcode = '55000'; end if;
  return true;
end;
$$;

create or replace function public.fail_finance_cron_item(
  p_run_id uuid,
  p_phase text,
  p_item_id uuid,
  p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
  v_owner uuid;
  v_expiry timestamptz;
  v_rows integer;
begin
  if p_phase not in ('connections', 'users')
    or p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'invalid finance cron failure' using errcode = '22023';
  end if;
  select lease.run_id, lease.lease_expires_at into v_owner, v_expiry
  from public.finance_cron_run_leases lease
  where lease.job_key = 'finance-daily' for update;
  if v_owner is distinct from p_run_id
    or v_expiry <= pg_catalog.clock_timestamp() then return null; end if;
  perform 1 from public.finance_cron_run_claims claim
  where claim.run_id = p_run_id and claim.phase = p_phase
    and claim.item_id = p_item_id and claim.completed_at is null
  for update;
  if not found then return null; end if;
  if p_phase = 'connections' then
    perform 1 from public.finance_cron_cursors cursor
    where cursor.job_key = 'finance-daily-plaid-sync' for update;
  else
    perform 1 from public.finance_cron_cursors cursor
    where cursor.job_key = 'finance-daily-user-jobs' for update;
  end if;
  if not found or v_expiry <= pg_catalog.clock_timestamp() then return null; end if;

  insert into public.finance_cron_item_failures(
    phase, item_id, attempt_count, last_error_code, next_attempt_at,
    quarantined_at, first_failed_at, last_failed_at
  ) values (
    p_phase, p_item_id, 1, p_error_code, pg_catalog.now() + interval '15 minutes',
    null, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (phase, item_id) do update
  set attempt_count = least(3, public.finance_cron_item_failures.attempt_count + 1),
      last_error_code = excluded.last_error_code,
      next_attempt_at = case public.finance_cron_item_failures.attempt_count + 1
        when 2 then pg_catalog.now() + interval '2 hours'
        else null
      end,
      quarantined_at = case when public.finance_cron_item_failures.attempt_count + 1 >= 3
        then pg_catalog.now() else null end,
      last_failed_at = pg_catalog.now()
  returning attempt_count into v_attempts;

  if p_phase = 'connections' then
    update public.finance_cron_cursors cursor
    set last_connection_id = case when cursor.last_connection_id is null or p_item_id > cursor.last_connection_id then p_item_id else cursor.last_connection_id end,
        updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-plaid-sync';
  else
    update public.finance_cron_cursors cursor
    set last_user_id = case when cursor.last_user_id is null or p_item_id > cursor.last_user_id then p_item_id else cursor.last_user_id end,
        updated_at = pg_catalog.now()
    where cursor.job_key = 'finance-daily-user-jobs';
  end if;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'finance cron failure cursor mutation failed' using errcode = '55000'; end if;
  update public.finance_cron_run_claims claim set completed_at = pg_catalog.now()
  where claim.phase = p_phase and claim.item_id = p_item_id
    and claim.run_id = p_run_id and claim.completed_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'finance cron failure claim mutation failed' using errcode = '55000'; end if;
  return case when v_attempts >= 3 then 'quarantined' else 'retry_scheduled' end;
end;
$$;

revoke all on function public.fail_finance_cron_item(uuid,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.fail_finance_cron_item(uuid,text,uuid,text)
  to service_role;

commit;
