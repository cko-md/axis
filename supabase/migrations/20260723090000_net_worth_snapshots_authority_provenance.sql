-- Financial truth authority boundary.
--
-- RLS establishes row ownership. These triggers establish authority: an
-- authenticated owner can keep using manual holdings/liabilities and legacy
-- snapshots, but cannot mint, edit, or delete provider-authoritative facts.
-- Provider facts are written only through the service-role path and must carry
-- linked-account provenance, a fresh retrieval time, and matched reconciliation.

begin;

alter table public.fund_connections
  add column if not exists authority text not null default 'legacy_unknown',
  add column if not exists verified_at timestamptz,
  add column if not exists action_required text,
  add column if not exists provider_event_at timestamptz;

alter table public.fund_connections
  drop constraint if exists fund_connections_authority_contract,
  add constraint fund_connections_authority_contract check (
    (authority = 'legacy_unknown' and verified_at is null)
    or (
      authority = 'provider_verified'
      and verified_at is not null
      and nullif(btrim(item_id), '') is not null
    )
  ),
  drop constraint if exists fund_connections_action_required_contract,
  add constraint fund_connections_action_required_contract check (
    action_required is null
    or action_required in (
      'login_required', 'provider_error', 'pending_disconnect', 'pending_expiration',
      'disconnect_pending'
    )
  );

drop policy if exists "fund_connections_insert_own" on public.fund_connections;
drop policy if exists "fund_connections_update_own" on public.fund_connections;
drop policy if exists "fund_connections_delete_own" on public.fund_connections;
drop policy if exists "fund_connections_select_own" on public.fund_connections;
create policy "fund_connections_select_own" on public.fund_connections
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.fund_connections from anon, authenticated;
grant select (
  id, provider, institution, mask, status, authority, verified_at,
  action_required, provider_event_at, created_at, updated_at
) on table public.fund_connections to authenticated;
grant all on table public.fund_connections to service_role;

create table if not exists public.fund_provider_coverage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.fund_connections(id) on delete cascade,
  provider text not null check (provider in ('plaid', 'public')),
  component text not null check (component in ('holdings', 'liabilities', 'transactions')),
  complete boolean not null,
  record_count integer check (record_count is null or record_count >= 0),
  retrieved_at timestamptz not null,
  last_attempt_at timestamptz not null default now(),
  availability_status text not null default 'available',
  availability_reason text,
  window_start date,
  window_end date,
  generation_id uuid,
  generation_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, component)
);
alter table public.fund_provider_coverage
  add column if not exists window_start date,
  add column if not exists window_end date,
  add column if not exists generation_id uuid,
  add column if not exists generation_hash text,
  add column if not exists last_attempt_at timestamptz not null default now(),
  add column if not exists availability_status text not null default 'available',
  add column if not exists availability_reason text;
alter table public.fund_provider_coverage
  alter column record_count drop not null,
  drop constraint if exists fund_provider_coverage_record_count_check,
  add constraint fund_provider_coverage_record_count_check check (
    record_count is null or record_count >= 0
  );
alter table public.fund_provider_coverage
  drop constraint if exists fund_provider_coverage_component_check,
  drop constraint if exists fund_provider_coverage_component_contract,
  drop constraint if exists fund_provider_coverage_component_provider_contract,
  drop constraint if exists fund_provider_coverage_transaction_generation_contract,
  add constraint fund_provider_coverage_component_contract check (
    component in ('holdings', 'liabilities', 'transactions')
  ),
  add constraint fund_provider_coverage_component_provider_contract check (
    component = 'holdings' or provider = 'plaid'
  ),
  add constraint fund_provider_coverage_transaction_generation_contract check (
    (
      component = 'transactions'
      and provider = 'plaid'
      and complete
      and record_count is not null
      and window_start is not null
      and window_end is not null
      and window_start <= window_end
      and window_end - window_start >= 90
      and generation_id is not null
      and generation_hash ~ '^[0-9a-f]{64}$'
    )
    or (
      component = 'holdings'
      and complete
      and record_count is not null
      and window_start is null
      and window_end is null
      and generation_id is not null
      and generation_hash ~ '^[0-9a-f]{64}$'
    )
    or (
      component = 'holdings'
      and not complete
      and window_start is null
      and window_end is null
      and generation_id is null
      and generation_hash is null
    )
    or (
      component = 'liabilities'
      and complete
      and record_count is not null
      and window_start is null
      and window_end is null
      and generation_id is not null
      and generation_hash ~ '^[0-9a-f]{64}$'
    )
    or (
      component = 'liabilities'
      and not complete
      and window_start is null
      and window_end is null
      and generation_id is null
      and generation_hash is null
    )
  ),
  drop constraint if exists fund_provider_coverage_availability_contract,
  add constraint fund_provider_coverage_availability_contract check (
    last_attempt_at >= retrieved_at
    and availability_status in ('available', 'unavailable', 'error')
    and (
      (availability_status = 'available' and availability_reason is null)
      or (
        availability_status <> 'available'
        and nullif(btrim(availability_reason), '') is not null
        and availability_reason in (
          'product_not_billed', 'provider_unavailable',
          'payload_incomplete', 'publish_failed'
        )
      )
    )
  );
alter table public.fund_provider_coverage enable row level security;
drop policy if exists "fund_provider_coverage_select_own" on public.fund_provider_coverage;
create policy "fund_provider_coverage_select_own"
  on public.fund_provider_coverage for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on table public.fund_provider_coverage from anon, authenticated;
grant select (
  id, user_id, connection_id, provider, component, complete, record_count, retrieved_at,
  last_attempt_at, availability_status, availability_reason,
  window_start, window_end, generation_id, generation_hash, created_at, updated_at
) on table public.fund_provider_coverage to authenticated;
grant all on table public.fund_provider_coverage to service_role;

alter table public.fund_holdings
  add column if not exists authority text not null default 'legacy_unknown',
  add column if not exists generation_id uuid;
alter table public.fund_liabilities
  add column if not exists generation_id uuid,
  add column if not exists authority text not null default 'legacy_unknown';

create or replace function public.fund_currency_minor_factor(p_currency text)
returns integer
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_currency is null or p_currency <> all (array[
      'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN',
      'BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL',
      'BSD','BTN','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY',
      'COP','CRC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP',
      'ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD',
      'GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR',
      'IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR','KMF',
      'KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL',
      'LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR',
      'MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR',
      'NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR',
      'RON','RSD','RUB','RWF','SAR','SBD','SCR','SDG','SEK','SGD',
      'SHP','SLE','SOS','SRD','SSP','STN','SYP','SZL','THB','TJS',
      'TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX','USD',
      'UYU','UZS','VES','VND','VUV','WST','XAF','XCD','XOF','XPF',
      'YER','ZAR','ZMW','ZWL'
    ]) then null
    when p_currency = any (array[
      'BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF',
      'UGX','VND','VUV','XAF','XOF','XPF'
    ]) then 1
    when p_currency = any (array['BHD','IQD','JOD','KWD','LYD','OMR','TND']) then 1000
    else 100
  end
$$;
revoke all on function public.fund_currency_minor_factor(text) from public, anon, authenticated;
grant execute on function public.fund_currency_minor_factor(text) to authenticated, service_role;

alter table public.fund_category_budgets
  add column if not exists currency text not null default 'USD';
alter table public.fund_category_budgets
  drop constraint if exists fund_category_budgets_currency_contract,
  add constraint fund_category_budgets_currency_contract check (
    category = btrim(category)
    and char_length(category) between 1 and 80
    and
    public.fund_currency_minor_factor(currency) is not null
    and monthly_limit >= 0
    and monthly_limit <= 100000000000
    and monthly_limit * public.fund_currency_minor_factor(currency)
      = trunc(monthly_limit * public.fund_currency_minor_factor(currency))
  ),
  drop constraint if exists fund_category_budgets_user_id_category_key;
create unique index if not exists fund_category_budgets_identity_uidx
  on public.fund_category_budgets (user_id, category, currency);

alter table public.fund_bank_transactions
  add column if not exists authority text not null default 'legacy_unknown',
  add column if not exists provider text,
  add column if not exists amount_minor bigint,
  add column if not exists generation_id uuid;

alter table public.fund_bank_transactions
  drop constraint if exists fund_bank_transactions_authority_contract,
  add constraint fund_bank_transactions_authority_contract check (
    (
      authority = 'legacy_unknown'
      and provider is null
      and amount_minor is null
      and generation_id is null
    )
    or (
      authority = 'provider'
      and provider = 'plaid'
      and connection_id is not null
      and retrieved_at is not null
      and generation_id is not null
      and amount_minor is not null
      and public.fund_currency_minor_factor(iso_currency_code) is not null
      and amount = amount_minor::numeric / public.fund_currency_minor_factor(iso_currency_code)
    )
  );

create index if not exists idx_fund_bank_transactions_generation
  on public.fund_bank_transactions (user_id, connection_id, generation_id, posted_date);

alter table public.fund_bank_transactions
  drop constraint if exists fund_bank_transactions_user_id_plaid_transaction_id_key;
create unique index if not exists fund_bank_transactions_provider_identity_uidx
  on public.fund_bank_transactions (
    user_id, provider, connection_id, plaid_transaction_id
  )
  where authority = 'provider';
create unique index if not exists fund_bank_transactions_manual_identity_uidx
  on public.fund_bank_transactions (user_id, plaid_transaction_id)
  where authority = 'legacy_unknown';

create or replace function public.guard_fund_bank_transaction_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      if new.authority = 'provider'
        or new.provider is not null
        or new.amount_minor is not null
        or new.generation_id is not null then
        raise exception 'provider bank transactions are server-managed'
          using errcode = '42501';
      end if;
      new.authority := 'legacy_unknown';
      new.provider := null;
      new.amount_minor := null;
      new.generation_id := null;
      return new;
    end if;
    if tg_op = 'DELETE' then
      if old.authority = 'provider' then
        raise exception 'provider bank transactions are server-managed'
          using errcode = '42501';
      end if;
      return old;
    end if;
    if old.authority = 'provider' and (
      new.user_id is distinct from old.user_id
      or new.connection_id is distinct from old.connection_id
      or new.plaid_transaction_id is distinct from old.plaid_transaction_id
      or new.account_id is distinct from old.account_id
      or new.merchant_name is distinct from old.merchant_name
      or new.raw_name is distinct from old.raw_name
      or new.amount is distinct from old.amount
      or new.amount_minor is distinct from old.amount_minor
      or new.iso_currency_code is distinct from old.iso_currency_code
      or new.plaid_category is distinct from old.plaid_category
      or new.is_transfer is distinct from old.is_transfer
      or new.pending is distinct from old.pending
      or new.posted_date is distinct from old.posted_date
      or new.authorized_date is distinct from old.authorized_date
      or new.split_parent_id is distinct from old.split_parent_id
      or new.retrieved_at is distinct from old.retrieved_at
      or new.authority is distinct from old.authority
      or new.provider is distinct from old.provider
      or new.generation_id is distinct from old.generation_id
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'provider bank transaction facts are immutable to owners'
        using errcode = '42501';
    end if;
    if new.authority is distinct from old.authority
      or new.provider is distinct from old.provider
      or new.amount_minor is distinct from old.amount_minor
      or new.generation_id is distinct from old.generation_id then
      raise exception 'bank transaction authority cannot be changed by owners'
        using errcode = '42501';
    end if;
    -- Owner-only annotation fields (category/review/notes) remain editable;
    -- the material provider facts were exhaustively compared above.
    return new;
  end if;
  if current_user <> 'postgres'
    and tg_op in ('UPDATE', 'DELETE')
    and old.authority = 'provider'
    and exists (
      select 1 from public.fund_provider_coverage coverage
      where coverage.user_id = old.user_id
        and coverage.connection_id = old.connection_id
        and coverage.provider = old.provider
        and coverage.component = 'transactions'
        and coverage.complete
        and coverage.generation_id = old.generation_id
    ) then
    raise exception 'published provider transaction facts are immutable'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.guard_fund_bank_transaction_authority() from public, anon, authenticated;
drop trigger if exists guard_fund_bank_transaction_authority on public.fund_bank_transactions;
create trigger guard_fund_bank_transaction_authority
before insert or update or delete on public.fund_bank_transactions
for each row execute function public.guard_fund_bank_transaction_authority();

create or replace function public.fund_transaction_generation_hash(
  p_user_id uuid,
  p_connection_id uuid,
  p_generation_id uuid,
  p_window_start date,
  p_window_end date
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'plaid_transaction_id', t.plaid_transaction_id,
            'account_id', t.account_id,
            'merchant_name', t.merchant_name,
            'raw_name', t.raw_name,
            'amount', t.amount::text,
            'amount_minor', t.amount_minor,
            'iso_currency_code', t.iso_currency_code,
            'plaid_category', t.plaid_category,
            'posted_date', t.posted_date,
            'authorized_date', t.authorized_date,
            'pending', t.pending
          )
          order by t.plaid_transaction_id
        ),
        '[]'::jsonb
      )::text,
      'sha256'
    ),
    'hex'
  )
  from public.fund_bank_transactions t
  where t.user_id = p_user_id
    and t.connection_id = p_connection_id
    and t.provider = 'plaid'
    and t.authority = 'provider'
    and t.generation_id = p_generation_id
    and t.posted_date between p_window_start and p_window_end
$$;
revoke all on function public.fund_transaction_generation_hash(uuid,uuid,uuid,date,date)
  from public, anon, authenticated;
grant execute on function public.fund_transaction_generation_hash(uuid,uuid,uuid,date,date)
  to authenticated, service_role;

create or replace function public.fund_holding_generation_hash(
  p_user_id uuid,
  p_connection_id uuid,
  p_generation_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'provider_record_id', h.provider_record_id,
            'symbol', h.symbol,
            'name', h.name,
            'shares', h.shares::text,
            'cost_basis', h.cost_basis::text,
            'currency', h.currency,
            'retrieved_at', h.retrieved_at,
            'effective_at', h.effective_at,
            'reconciliation_state', h.reconciliation_state
          )
          order by h.provider_record_id
        ),
        '[]'::jsonb
      )::text,
      'sha256'
    ),
    'hex'
  )
  from public.fund_holdings h
  where h.user_id = p_user_id
    and h.connection_id = p_connection_id
    and h.authority = 'provider'
    and h.generation_id = p_generation_id
$$;
revoke all on function public.fund_holding_generation_hash(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fund_holding_generation_hash(uuid,uuid,uuid)
  to authenticated, service_role;

create or replace function public.fund_liability_generation_hash(
  p_user_id uuid,
  p_connection_id uuid,
  p_generation_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'provider_record_id', l.provider_record_id,
            'kind', l.kind,
            'name', l.name,
            'balance', l.balance::text,
            'apr', l.apr::text,
            'minimum_payment', l.minimum_payment::text,
            'due_date', l.due_date,
            'currency', l.currency,
            'retrieved_at', l.retrieved_at,
            'effective_at', l.effective_at,
            'reconciliation_state', l.reconciliation_state
          )
          order by l.provider_record_id
        ),
        '[]'::jsonb
      )::text,
      'sha256'
    ),
    'hex'
  )
  from public.fund_liabilities l
  where l.user_id = p_user_id
    and l.connection_id = p_connection_id
    and l.provider = 'plaid'
    and l.authority = 'provider'
    and l.generation_id = p_generation_id
$$;
revoke all on function public.fund_liability_generation_hash(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fund_liability_generation_hash(uuid,uuid,uuid)
  to authenticated, service_role;

create or replace function public.guard_fund_provider_coverage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked boolean;
  max_age interval;
  actual_count integer;
  actual_hash text;
begin
  if tg_op = 'UPDATE' and (
    old.user_id is distinct from new.user_id
    or old.connection_id is distinct from new.connection_id
    or old.provider is distinct from new.provider
    or old.component is distinct from new.component
  ) then
    raise exception 'provider coverage identity is immutable'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE'
    and (old.complete or new.complete)
    and old.generation_id is not distinct from new.generation_id
    and (
      old.complete is distinct from new.complete
      or old.record_count is distinct from new.record_count
      or old.retrieved_at is distinct from new.retrieved_at
      or old.window_start is distinct from new.window_start
      or old.window_end is distinct from new.window_end
      or old.generation_hash is distinct from new.generation_hash
    ) then
    raise exception 'provider coverage generation facts are immutable'
      using errcode = '23514';
  end if;
  max_age := case when new.component = 'holdings' then interval '48 hours' else interval '24 hours' end;
  if (
    tg_op = 'INSERT'
    or old.retrieved_at is distinct from new.retrieved_at
    or old.generation_id is distinct from new.generation_id
    or old.generation_hash is distinct from new.generation_hash
  ) and (
    new.retrieved_at < now() - max_age
    or new.retrieved_at > now() + interval '1 minute'
  ) then
    raise exception 'provider coverage retrieved_at is not fresh'
      using errcode = '22023';
  end if;
  select exists (
    select 1 from public.fund_connections c
    where c.id = new.connection_id
      and c.user_id = new.user_id
      and c.provider = new.provider
      and c.status = 'linked'
      and c.authority = 'provider_verified'
      and c.verified_at is not null
  ) into linked;
  if not linked then
    raise exception 'provider coverage connection is not authoritative'
      using errcode = '23514';
  end if;
  if new.component = 'transactions' then
    select count(*)::integer
    into actual_count
    from public.fund_bank_transactions t
    where t.user_id = new.user_id
      and t.connection_id = new.connection_id
      and t.provider = new.provider
      and t.authority = 'provider'
      and t.generation_id = new.generation_id
      and t.posted_date between new.window_start and new.window_end;
    actual_hash := public.fund_transaction_generation_hash(
      new.user_id,
      new.connection_id,
      new.generation_id,
      new.window_start,
      new.window_end
    );
    if actual_count <> new.record_count or actual_hash is distinct from new.generation_hash then
      raise exception 'transaction coverage does not match its generation'
        using errcode = '23514';
    end if;
  elsif new.component = 'holdings' and new.complete then
    select count(*)::integer
    into actual_count
    from public.fund_holdings h
    where h.user_id = new.user_id
      and h.connection_id = new.connection_id
      and h.provider = new.provider
      and h.authority = 'provider'
      and h.generation_id = new.generation_id;
    actual_hash := public.fund_holding_generation_hash(
      new.user_id,
      new.connection_id,
      new.generation_id
    );
    if actual_count <> new.record_count or actual_hash is distinct from new.generation_hash then
      raise exception 'holding coverage does not match its generation'
        using errcode = '23514';
    end if;
  elsif new.component = 'liabilities' and new.complete then
    select count(*)::integer
    into actual_count
    from public.fund_liabilities l
    where l.user_id = new.user_id
      and l.connection_id = new.connection_id
      and l.provider = new.provider
      and l.authority = 'provider'
      and l.generation_id = new.generation_id;
    actual_hash := public.fund_liability_generation_hash(
      new.user_id,
      new.connection_id,
      new.generation_id
    );
    if actual_count <> new.record_count or actual_hash is distinct from new.generation_hash then
      raise exception 'liability coverage does not match its generation'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_fund_provider_coverage() from public, anon, authenticated;
drop trigger if exists guard_fund_provider_coverage on public.fund_provider_coverage;
create trigger guard_fund_provider_coverage
before insert or update on public.fund_provider_coverage
for each row execute function public.guard_fund_provider_coverage();

create or replace function public.publish_fund_transaction_generation(
  p_user_id uuid,
  p_connection_id uuid,
  p_window_start date,
  p_window_end date,
  p_retrieved_at timestamptz,
  p_generation_id uuid,
  p_rows jsonb
)
returns table(record_count integer, generation_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_hash text;
  v_connection_valid boolean;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'transaction publication requires service role'
      using errcode = '42501';
  end if;
  if p_user_id is null
    or p_connection_id is null
    or p_window_start is null
    or p_window_end is null
    or p_window_start > p_window_end
    or p_window_end - p_window_start < 90
    or p_retrieved_at is null
    or p_retrieved_at < pg_catalog.now() - interval '24 hours'
    or p_retrieved_at > pg_catalog.now() + interval '1 minute'
    or p_generation_id is null
    or p_rows is null
    or pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or pg_catalog.pg_column_size(p_rows) > 4194304
    or pg_catalog.jsonb_array_length(p_rows) > 5000 then
    raise exception 'invalid transaction publication boundary'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_rows) as payload(row)
    where pg_catalog.jsonb_typeof(payload.row) <> 'object'
      or pg_catalog.pg_column_size(payload.row) > 8192
      or (
        select pg_catalog.array_agg(key order by key)
        from pg_catalog.jsonb_object_keys(payload.row) as keys(key)
      ) is distinct from array[
        'account_id',
        'amount',
        'amount_minor',
        'authority',
        'authorized_date',
        'generation_id',
        'iso_currency_code',
        'merchant_name',
        'pending',
        'plaid_category',
        'plaid_transaction_id',
        'posted_date',
        'provider',
        'raw_name',
        'retrieved_at'
      ]::text[]
      or pg_catalog.length(payload.row->>'plaid_transaction_id') not between 1 and 255
      or pg_catalog.length(payload.row->>'account_id') not between 1 and 255
      or pg_catalog.length(payload.row->>'merchant_name') not between 1 and 512
      or pg_catalog.length(payload.row->>'raw_name') not between 1 and 512
      or pg_catalog.length(payload.row->>'amount') not between 1 and 64
      or pg_catalog.length(payload.row->>'iso_currency_code') <> 3
      or pg_catalog.length(payload.row->>'plaid_category') not between 1 and 80
      or pg_catalog.length(payload.row->>'posted_date') <> 10
      or (
        payload.row->'authorized_date' <> 'null'::jsonb
        and pg_catalog.length(payload.row->>'authorized_date') <> 10
      )
      or pg_catalog.length(payload.row->>'retrieved_at') > 64
      or payload.row->>'provider' <> 'plaid'
      or payload.row->>'authority' <> 'provider'
      or pg_catalog.jsonb_typeof(payload.row->'amount_minor') <> 'number'
      or pg_catalog.length(payload.row->>'amount_minor') > 32
      or pg_catalog.jsonb_typeof(payload.row->'pending') <> 'boolean'
  ) then
    raise exception 'transaction publication row shape is invalid'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_connection_id::text || ':transactions', 0)
  );
  if exists (
    select 1 from public.fund_provider_coverage coverage
    where coverage.connection_id = p_connection_id
      and coverage.component = 'transactions'
      and coverage.last_attempt_at >= p_retrieved_at
  ) then
    raise exception 'transaction publication is older than the latest attempt'
      using errcode = '40001';
  end if;
  select exists (
    select 1 from public.fund_connections c
    where c.id = p_connection_id
      and c.user_id = p_user_id
      and c.provider = 'plaid'
      and c.status = 'linked'
      and c.authority = 'provider_verified'
      and c.verified_at is not null
  ) into v_connection_valid;
  if not v_connection_valid then
    raise exception 'transaction publication connection is not authoritative'
      using errcode = '23514';
  end if;

  insert into public.fund_bank_transactions (
    user_id, connection_id, plaid_transaction_id, account_id, merchant_name,
    raw_name, amount, amount_minor, iso_currency_code, plaid_category,
    posted_date, authorized_date, pending, retrieved_at, provider, authority,
    generation_id, is_transfer, updated_at
  )
  select
    p_user_id,
    p_connection_id,
    row.plaid_transaction_id,
    row.account_id,
    row.merchant_name,
    row.raw_name,
    row.amount::numeric,
    row.amount_minor,
    row.iso_currency_code,
    row.plaid_category,
    row.posted_date,
    row.authorized_date,
    row.pending,
    p_retrieved_at,
    'plaid',
    'provider',
    p_generation_id,
    false,
    pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(p_rows) as row(
    plaid_transaction_id text,
    account_id text,
    merchant_name text,
    raw_name text,
    amount text,
    amount_minor bigint,
    iso_currency_code text,
    plaid_category text,
    posted_date date,
    authorized_date date,
    pending boolean,
    retrieved_at timestamptz,
    provider text,
    authority text,
    generation_id uuid
  )
  where nullif(pg_catalog.btrim(row.plaid_transaction_id), '') is not null
    and nullif(pg_catalog.btrim(row.account_id), '') is not null
    and nullif(pg_catalog.btrim(row.merchant_name), '') is not null
    and nullif(pg_catalog.btrim(row.raw_name), '') is not null
    and row.posted_date between p_window_start and p_window_end
    and row.retrieved_at = p_retrieved_at
    and row.provider = 'plaid'
    and row.authority = 'provider'
    and row.generation_id = p_generation_id
    and public.fund_currency_minor_factor(row.iso_currency_code) is not null
    and row.amount::numeric = row.amount_minor::numeric
      / public.fund_currency_minor_factor(row.iso_currency_code)
  on conflict (user_id, provider, connection_id, plaid_transaction_id)
    where authority = 'provider'
  do update set
    connection_id = excluded.connection_id,
    account_id = excluded.account_id,
    merchant_name = excluded.merchant_name,
    raw_name = excluded.raw_name,
    amount = excluded.amount,
    amount_minor = excluded.amount_minor,
    iso_currency_code = excluded.iso_currency_code,
    plaid_category = excluded.plaid_category,
    posted_date = excluded.posted_date,
    authorized_date = excluded.authorized_date,
    pending = excluded.pending,
    retrieved_at = excluded.retrieved_at,
    provider = excluded.provider,
    authority = excluded.authority,
    generation_id = excluded.generation_id,
    is_transfer = false,
    updated_at = excluded.updated_at;

  get diagnostics v_count = row_count;
  if v_count <> pg_catalog.jsonb_array_length(p_rows) then
    raise exception 'transaction publication contains invalid or duplicate facts'
      using errcode = '22023';
  end if;

  delete from public.fund_bank_transactions t
  where t.user_id = p_user_id
    and t.connection_id = p_connection_id
    and t.provider = 'plaid'
    and t.authority = 'provider'
    and t.posted_date between p_window_start and p_window_end
    and t.generation_id <> p_generation_id;

  update public.fund_bank_transactions t
  set is_transfer = false,
      updated_at = pg_catalog.now()
  where t.user_id = p_user_id
    and t.provider = 'plaid'
    and t.authority = 'provider'
    and t.posted_date between p_window_start - 2 and p_window_end + 2
    and t.is_transfer;

  with candidates as (
    select
      debit.id as debit_id,
      credit.id as credit_id,
      pg_catalog.abs(credit.posted_date - debit.posted_date) as day_distance,
      row_number() over (
        partition by debit.id
        order by pg_catalog.abs(credit.posted_date - debit.posted_date), credit.posted_date, credit.id
      ) as debit_choice,
      row_number() over (
        partition by credit.id
        order by pg_catalog.abs(credit.posted_date - debit.posted_date), debit.posted_date, debit.id
      ) as credit_choice
    from public.fund_bank_transactions debit
    join public.fund_bank_transactions credit
      on credit.user_id = debit.user_id
     and credit.provider = debit.provider
     and credit.authority = debit.authority
     and credit.iso_currency_code = debit.iso_currency_code
     and credit.amount_minor = -debit.amount_minor
     and credit.amount_minor > 0
     and debit.amount_minor < 0
     and credit.connection_id is not null
     and debit.connection_id is not null
     and (
       credit.connection_id <> debit.connection_id
       or credit.account_id <> debit.account_id
     )
     and pg_catalog.abs(credit.posted_date - debit.posted_date) <= 2
    where debit.user_id = p_user_id
      and debit.provider = 'plaid'
      and debit.authority = 'provider'
      and debit.posted_date between p_window_start - 2 and p_window_end + 2
  ),
  pairs as (
    select debit_id, credit_id
    from candidates
    where debit_choice = 1 and credit_choice = 1
  ),
  paired_ids as (
    select debit_id as id from pairs
    union all
    select credit_id as id from pairs
  )
  update public.fund_bank_transactions fact_row
  set is_transfer = true,
      updated_at = pg_catalog.now()
  from paired_ids
  where fact_row.id = paired_ids.id;

  select count(*)::integer
  into v_count
  from public.fund_bank_transactions t
  where t.user_id = p_user_id
    and t.connection_id = p_connection_id
    and t.provider = 'plaid'
    and t.authority = 'provider'
    and t.generation_id = p_generation_id
    and t.posted_date between p_window_start and p_window_end;
  if v_count <> pg_catalog.jsonb_array_length(p_rows) then
    raise exception 'transaction publication count mismatch'
      using errcode = '23514';
  end if;

  v_hash := public.fund_transaction_generation_hash(
    p_user_id,
    p_connection_id,
    p_generation_id,
    p_window_start,
    p_window_end
  );
  insert into public.fund_provider_coverage (
    user_id, connection_id, provider, component, complete, record_count,
    retrieved_at, last_attempt_at, availability_status, availability_reason,
    window_start, window_end, generation_id, generation_hash,
    updated_at
  ) values (
    p_user_id, p_connection_id, 'plaid', 'transactions', true, v_count,
    p_retrieved_at, p_retrieved_at, 'available', null,
    p_window_start, p_window_end, p_generation_id, v_hash,
    pg_catalog.now()
  )
  on conflict (connection_id, component) do update set
    user_id = excluded.user_id,
    provider = excluded.provider,
    complete = excluded.complete,
    record_count = excluded.record_count,
    retrieved_at = excluded.retrieved_at,
    last_attempt_at = excluded.last_attempt_at,
    availability_status = excluded.availability_status,
    availability_reason = excluded.availability_reason,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    generation_id = excluded.generation_id,
    generation_hash = excluded.generation_hash,
    updated_at = excluded.updated_at;

  return query select v_count, v_hash;
end;
$$;
alter function public.publish_fund_transaction_generation(
  uuid,uuid,date,date,timestamptz,uuid,jsonb
) owner to postgres;
revoke all on function public.publish_fund_transaction_generation(uuid,uuid,date,date,timestamptz,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_fund_transaction_generation(uuid,uuid,date,date,timestamptz,uuid,jsonb)
  to service_role;

create or replace function public.publish_fund_holding_generation(
  p_user_id uuid,
  p_connection_id uuid,
  p_retrieved_at timestamptz,
  p_generation_id uuid,
  p_rows jsonb
)
returns table(record_count integer, generation_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_hash text;
  v_connection_valid boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_connection_id::text || ':holdings', 0)
  );
  if exists (
    select 1 from public.fund_provider_coverage coverage
    where coverage.connection_id = p_connection_id
      and coverage.component = 'holdings'
      and coverage.last_attempt_at >= p_retrieved_at
  ) then
    raise exception 'holding publication is older than the latest attempt'
      using errcode = '40001';
  end if;
  if p_user_id is null or p_connection_id is null or p_generation_id is null
    or p_retrieved_at is null
    or p_retrieved_at < pg_catalog.now() - interval '48 hours'
    or p_retrieved_at > pg_catalog.now() + interval '1 minute'
    or pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 512 then
    raise exception 'invalid holding publication'
      using errcode = '22023';
  end if;
  select exists (
    select 1
    from public.fund_connections c
    where c.id = p_connection_id
      and c.user_id = p_user_id
      and c.provider = 'plaid'
      and c.status = 'linked'
      and c.authority = 'provider_verified'
      and c.verified_at is not null
  ) into v_connection_valid;
  if not v_connection_valid then
    raise exception 'holding publication connection is not authoritative'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_rows) row_value
    where pg_catalog.jsonb_typeof(row_value) <> 'object'
      or nullif(pg_catalog.btrim(row_value->>'provider_record_id'), '') is null
      or pg_catalog.char_length(row_value->>'provider_record_id') > 512
      or coalesce(row_value->>'symbol', '') !~ '^[A-Z][A-Z0-9.-]{0,14}$'
      or nullif(pg_catalog.btrim(row_value->>'name'), '') is null
      or pg_catalog.char_length(row_value->>'name') > 256
      or public.fund_currency_minor_factor(row_value->>'currency') is null
      or coalesce(row_value->>'shares', '') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or (row_value->>'shares')::numeric <= 0
      or coalesce(row_value->>'cost_basis', '') !~ '^[0-9]+(\.[0-9]{1,3})?$'
      or (row_value->>'cost_basis')::numeric > 100000000000
      or (row_value->>'cost_basis')::numeric
        * public.fund_currency_minor_factor(row_value->>'currency')
        <> pg_catalog.trunc(
          (row_value->>'cost_basis')::numeric
          * public.fund_currency_minor_factor(row_value->>'currency')
        )
  ) then
    raise exception 'invalid holding publication row'
      using errcode = '22023';
  end if;
  if (
    select count(*) <> count(distinct row_value->>'provider_record_id')
    from pg_catalog.jsonb_array_elements(p_rows) row_value
  ) then
    raise exception 'duplicate holding provider identity'
      using errcode = '23505';
  end if;

  delete from public.fund_holdings
  where user_id = p_user_id
    and connection_id = p_connection_id
    and provider = 'plaid'
    and authority = 'provider';

  insert into public.fund_holdings (
    user_id, symbol, name, shares, cost_basis, sort_order, source,
    connection_id, provider, provider_record_id, retrieved_at, effective_at,
    currency, reconciliation_state, authority, generation_id, updated_at
  )
  select
    p_user_id,
    row_value->>'symbol',
    row_value->>'name',
    (row_value->>'shares')::numeric,
    (row_value->>'cost_basis')::numeric,
    (row_number() over (order by row_value->>'provider_record_id'))::integer - 1,
    'plaid',
    p_connection_id,
    'plaid',
    row_value->>'provider_record_id',
    p_retrieved_at,
    nullif(row_value->>'effective_at', '')::timestamptz,
    row_value->>'currency',
    'matched',
    'provider',
    p_generation_id,
    pg_catalog.now()
  from pg_catalog.jsonb_array_elements(p_rows) row_value;

  select count(*)::integer
  into v_count
  from public.fund_holdings h
  where h.user_id = p_user_id
    and h.connection_id = p_connection_id
    and h.provider = 'plaid'
    and h.authority = 'provider'
    and h.generation_id = p_generation_id;
  if v_count <> pg_catalog.jsonb_array_length(p_rows) then
    raise exception 'holding publication count mismatch'
      using errcode = '23514';
  end if;
  v_hash := public.fund_holding_generation_hash(
    p_user_id, p_connection_id, p_generation_id
  );
  insert into public.fund_provider_coverage (
    user_id, connection_id, provider, component, complete, record_count,
    retrieved_at, last_attempt_at, availability_status, availability_reason,
    window_start, window_end, generation_id, generation_hash,
    updated_at
  ) values (
    p_user_id, p_connection_id, 'plaid', 'holdings', true, v_count,
    p_retrieved_at, p_retrieved_at, 'available', null,
    null, null, p_generation_id, v_hash, pg_catalog.now()
  )
  on conflict (connection_id, component) do update set
    user_id = excluded.user_id,
    provider = excluded.provider,
    complete = excluded.complete,
    record_count = excluded.record_count,
    retrieved_at = excluded.retrieved_at,
    last_attempt_at = excluded.last_attempt_at,
    availability_status = excluded.availability_status,
    availability_reason = excluded.availability_reason,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    generation_id = excluded.generation_id,
    generation_hash = excluded.generation_hash,
    updated_at = excluded.updated_at;
  return query select v_count, v_hash;
end;
$$;
alter function public.publish_fund_holding_generation(
  uuid,uuid,timestamptz,uuid,jsonb
) owner to postgres;
revoke all on function public.publish_fund_holding_generation(uuid,uuid,timestamptz,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_fund_holding_generation(uuid,uuid,timestamptz,uuid,jsonb)
  to service_role;

create or replace function public.publish_fund_liability_generation(
  p_user_id uuid,
  p_connection_id uuid,
  p_retrieved_at timestamptz,
  p_generation_id uuid,
  p_rows jsonb
)
returns table(record_count integer, generation_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_hash text;
  v_connection_valid boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_connection_id::text || ':liabilities', 0)
  );
  if exists (
    select 1 from public.fund_provider_coverage coverage
    where coverage.connection_id = p_connection_id
      and coverage.component = 'liabilities'
      and coverage.last_attempt_at >= p_retrieved_at
  ) then
    raise exception 'liability publication is older than the latest attempt'
      using errcode = '40001';
  end if;
  if p_user_id is null or p_connection_id is null or p_generation_id is null
    or p_retrieved_at is null
    or p_retrieved_at < pg_catalog.now() - interval '24 hours'
    or p_retrieved_at > pg_catalog.now() + interval '1 minute'
    or pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 256 then
    raise exception 'invalid liability publication'
      using errcode = '22023';
  end if;
  select exists (
    select 1
    from public.fund_connections c
    where c.id = p_connection_id
      and c.user_id = p_user_id
      and c.provider = 'plaid'
      and c.status = 'linked'
      and c.authority = 'provider_verified'
      and c.verified_at is not null
  ) into v_connection_valid;
  if not v_connection_valid then
    raise exception 'liability publication connection is not authoritative'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_rows) row_value
    where pg_catalog.jsonb_typeof(row_value) <> 'object'
      or nullif(pg_catalog.btrim(row_value->>'provider_record_id'), '') is null
      or pg_catalog.char_length(row_value->>'provider_record_id') > 512
      or (row_value->>'kind') not in ('credit_card', 'mortgage', 'student_loan')
      or nullif(pg_catalog.btrim(row_value->>'name'), '') is null
      or pg_catalog.char_length(row_value->>'name') > 256
      or public.fund_currency_minor_factor(row_value->>'currency') is null
      or coalesce(row_value->>'balance', '') !~ '^[0-9]+(\.[0-9]{1,3})?$'
      or (row_value->>'balance')::numeric > 100000000000
      or (row_value->>'balance')::numeric
        * public.fund_currency_minor_factor(row_value->>'currency')
        <> pg_catalog.trunc(
          (row_value->>'balance')::numeric
          * public.fund_currency_minor_factor(row_value->>'currency')
        )
      or (
        row_value ? 'minimum_payment'
        and row_value->>'minimum_payment' is not null
        and (
          coalesce(row_value->>'minimum_payment', '') !~ '^[0-9]+(\.[0-9]{1,3})?$'
          or (row_value->>'minimum_payment')::numeric > 100000000000
          or (row_value->>'minimum_payment')::numeric
            * public.fund_currency_minor_factor(row_value->>'currency')
            <> pg_catalog.trunc(
              (row_value->>'minimum_payment')::numeric
              * public.fund_currency_minor_factor(row_value->>'currency')
            )
        )
      )
      or (
        row_value ? 'due_date'
        and row_value->>'due_date' is not null
        and coalesce(row_value->>'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      )
  ) then
    raise exception 'invalid liability publication row'
      using errcode = '22023';
  end if;
  if (
    select count(*) <> count(distinct row_value->>'provider_record_id')
    from pg_catalog.jsonb_array_elements(p_rows) row_value
  ) then
    raise exception 'duplicate liability provider identity'
      using errcode = '23505';
  end if;

  delete from public.fund_liabilities
  where user_id = p_user_id
    and connection_id = p_connection_id
    and provider = 'plaid'
    and authority = 'provider';

  insert into public.fund_liabilities (
    user_id, connection_id, kind, name, balance, apr, minimum_payment,
    due_date, source, provider, provider_record_id, retrieved_at, effective_at,
    currency, reconciliation_state, authority, generation_id, updated_at
  )
  select
    p_user_id,
    p_connection_id,
    row_value->>'kind',
    row_value->>'name',
    (row_value->>'balance')::numeric,
    nullif(row_value->>'apr', '')::numeric,
    nullif(row_value->>'minimum_payment', '')::numeric,
    nullif(row_value->>'due_date', '')::date,
    'plaid',
    'plaid',
    row_value->>'provider_record_id',
    p_retrieved_at,
    nullif(row_value->>'effective_at', '')::timestamptz,
    row_value->>'currency',
    'matched',
    'provider',
    p_generation_id,
    pg_catalog.now()
  from pg_catalog.jsonb_array_elements(p_rows) row_value;

  select count(*)::integer
  into v_count
  from public.fund_liabilities l
  where l.user_id = p_user_id
    and l.connection_id = p_connection_id
    and l.provider = 'plaid'
    and l.authority = 'provider'
    and l.generation_id = p_generation_id;
  if v_count <> pg_catalog.jsonb_array_length(p_rows) then
    raise exception 'liability publication count mismatch'
      using errcode = '23514';
  end if;
  v_hash := public.fund_liability_generation_hash(
    p_user_id, p_connection_id, p_generation_id
  );
  insert into public.fund_provider_coverage (
    user_id, connection_id, provider, component, complete, record_count,
    retrieved_at, last_attempt_at, availability_status, availability_reason,
    window_start, window_end, generation_id, generation_hash,
    updated_at
  ) values (
    p_user_id, p_connection_id, 'plaid', 'liabilities', true, v_count,
    p_retrieved_at, p_retrieved_at, 'available', null,
    null, null, p_generation_id, v_hash, pg_catalog.now()
  )
  on conflict (connection_id, component) do update set
    user_id = excluded.user_id,
    provider = excluded.provider,
    complete = excluded.complete,
    record_count = excluded.record_count,
    retrieved_at = excluded.retrieved_at,
    last_attempt_at = excluded.last_attempt_at,
    availability_status = excluded.availability_status,
    availability_reason = excluded.availability_reason,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    generation_id = excluded.generation_id,
    generation_hash = excluded.generation_hash,
    updated_at = excluded.updated_at;
  return query select v_count, v_hash;
end;
$$;
alter function public.publish_fund_liability_generation(
  uuid,uuid,timestamptz,uuid,jsonb
) owner to postgres;
revoke all on function public.publish_fund_liability_generation(uuid,uuid,timestamptz,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_fund_liability_generation(uuid,uuid,timestamptz,uuid,jsonb)
  to service_role;

create or replace function public.mark_fund_provider_component_unavailable(
  p_user_id uuid,
  p_connection_id uuid,
  p_component text,
  p_record_count integer,
  p_attempted_at timestamptz,
  p_availability_status text,
  p_availability_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_valid boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_connection_id::text || ':' || p_component, 0)
  );
  if p_user_id is null or p_connection_id is null
    or p_component not in ('holdings', 'liabilities')
    or (p_record_count is not null and p_record_count < 0)
    or p_attempted_at is null
    or p_attempted_at < pg_catalog.now() - interval '24 hours'
    or p_attempted_at > pg_catalog.now() + interval '1 minute'
    or p_availability_status not in ('unavailable', 'error')
    or nullif(pg_catalog.btrim(p_availability_reason), '') is null
    or p_availability_reason not in (
      'product_not_billed', 'provider_unavailable',
      'payload_incomplete', 'publish_failed'
    ) then
    raise exception 'invalid provider component unavailability publication'
      using errcode = '22023';
  end if;
  select exists (
    select 1
    from public.fund_connections c
    where c.id = p_connection_id
      and c.user_id = p_user_id
      and c.provider = 'plaid'
      and c.status = 'linked'
      and c.authority = 'provider_verified'
      and c.verified_at is not null
  ) into v_connection_valid;
  if not v_connection_valid then
    raise exception 'provider component connection is not authoritative'
      using errcode = '23514';
  end if;
  update public.fund_provider_coverage
  set last_attempt_at = p_attempted_at,
      availability_status = p_availability_status,
      availability_reason = p_availability_reason,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and connection_id = p_connection_id
    and provider = 'plaid'
    and component = p_component
    and last_attempt_at < p_attempted_at;
  if found then return true; end if;
  if exists (
    select 1 from public.fund_provider_coverage coverage
    where coverage.connection_id = p_connection_id
      and coverage.component = p_component
  ) then
    return false;
  end if;

  insert into public.fund_provider_coverage (
    user_id, connection_id, provider, component, complete, record_count,
    retrieved_at, last_attempt_at, availability_status, availability_reason,
    window_start, window_end, generation_id, generation_hash,
    updated_at
  ) values (
    p_user_id, p_connection_id, 'plaid', p_component, false, p_record_count,
    p_attempted_at, p_attempted_at, p_availability_status, p_availability_reason,
    null, null, null, null, pg_catalog.now()
  );
  return true;
end;
$$;
alter function public.mark_fund_provider_component_unavailable(uuid,uuid,text,integer,timestamptz,text,text)
  owner to postgres;
revoke all on function public.mark_fund_provider_component_unavailable(uuid,uuid,text,integer,timestamptz,text,text)
  from public, anon, authenticated;
grant execute on function public.mark_fund_provider_component_unavailable(uuid,uuid,text,integer,timestamptz,text,text)
  to service_role;

create or replace function public.check_fund_transaction_history_coverage(
  p_user_id uuid,
  p_window_start date,
  p_window_end date
)
returns table(available boolean, reason text, coverage jsonb, lineage_hash text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_connection_count integer;
  v_coverage_count integer;
  v_coverage jsonb;
begin
  if p_window_start is null or p_window_end is null or p_window_start > p_window_end then
    return query select false, 'TRANSACTION_HISTORY_UNAVAILABLE', '[]'::jsonb, null::text;
    return;
  end if;
  if current_user <> 'service_role' and (select auth.uid()) is distinct from p_user_id then
    raise exception 'transaction coverage owner mismatch'
      using errcode = '42501';
  end if;

  select count(*)::integer
  into v_connection_count
  from public.fund_connections c
  where c.user_id = p_user_id
    and c.provider = 'plaid'
    and c.status = 'linked'
    and c.authority = 'provider_verified'
    and c.verified_at is not null;
  if v_connection_count = 0 then
    return query select false, 'TRANSACTION_HISTORY_UNAVAILABLE', '[]'::jsonb, null::text;
    return;
  end if;

  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'connection_id', coverage_row.connection_id,
          'provider', coverage_row.provider,
          'component', coverage_row.component,
          'complete', coverage_row.complete,
          'record_count', coverage_row.record_count,
          'retrieved_at', coverage_row.retrieved_at,
          'window_start', coverage_row.window_start,
          'window_end', coverage_row.window_end,
          'generation_id', coverage_row.generation_id,
          'generation_hash', coverage_row.generation_hash
        )
        order by coverage_row.connection_id
      ),
      '[]'::jsonb
    )
  into v_coverage_count, v_coverage
  from public.fund_provider_coverage coverage_row
  join public.fund_connections connection
    on connection.id = coverage_row.connection_id
   and connection.user_id = coverage_row.user_id
   and connection.provider = coverage_row.provider
  where coverage_row.user_id = p_user_id
    and coverage_row.provider = 'plaid'
    and coverage_row.component = 'transactions'
    and coverage_row.complete
    and coverage_row.availability_status = 'available'
    and coverage_row.window_start <= p_window_start
    and coverage_row.window_end >= p_window_end
    and coverage_row.retrieved_at between now() - interval '24 hours' and now() + interval '1 minute'
    and connection.status = 'linked'
    and connection.authority = 'provider_verified'
    and connection.verified_at is not null
    and coverage_row.generation_hash = public.fund_transaction_generation_hash(
      coverage_row.user_id,
      coverage_row.connection_id,
      coverage_row.generation_id,
      coverage_row.window_start,
      coverage_row.window_end
    )
    and coverage_row.record_count = (
      select count(*)::integer
      from public.fund_bank_transactions fact
      where fact.user_id = coverage_row.user_id
        and fact.connection_id = coverage_row.connection_id
        and fact.provider = coverage_row.provider
        and fact.authority = 'provider'
        and fact.generation_id = coverage_row.generation_id
        and fact.posted_date between coverage_row.window_start and coverage_row.window_end
    );

  if v_coverage_count <> v_connection_count then
    return query select false, 'TRANSACTION_HISTORY_UNAVAILABLE', '[]'::jsonb, null::text;
    return;
  end if;
  return query
    select
      true,
      null::text,
      v_coverage,
      encode(extensions.digest(v_coverage::text, 'sha256'), 'hex');
end;
$$;
revoke all on function public.check_fund_transaction_history_coverage(uuid,date,date)
  from public, anon;
grant execute on function public.check_fund_transaction_history_coverage(uuid,date,date)
  to authenticated, service_role;

alter table public.fund_recurring_transactions
  add column if not exists currency text not null default 'USD',
  add column if not exists source_generations jsonb,
  add column if not exists source_generation_hash text;

update public.fund_recurring_transactions
set source_generations = null,
    source_generation_hash = null
where source = 'manual';

alter table public.fund_recurring_transactions
  drop constraint if exists fund_recurring_transactions_lineage_contract,
  add constraint fund_recurring_transactions_lineage_contract check (
    public.fund_currency_minor_factor(currency) is not null
    and (
      (
        source = 'manual'
        and source_generations is null
        and source_generation_hash is null
      )
      or (
        source = 'detected'
        and (
          (source_generations is null and source_generation_hash is null)
          or (
            jsonb_typeof(source_generations) = 'array'
            and jsonb_array_length(source_generations) > 0
            and source_generation_hash ~ '^[0-9a-f]{64}$'
          )
        )
      )
    )
  );

create unique index if not exists fund_recurring_transactions_identity_uidx
  on public.fund_recurring_transactions (user_id, merchant_name, currency, source);
alter table public.fund_recurring_transactions
  drop constraint if exists fund_recurring_transactions_user_id_merchant_name_key;

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
drop trigger if exists guard_fund_recurring_transaction_authority
  on public.fund_recurring_transactions;
create trigger guard_fund_recurring_transaction_authority
before insert or update or delete on public.fund_recurring_transactions
for each row execute function public.guard_fund_recurring_transaction_authority();

alter table public.fund_holdings
  add column if not exists authority text not null default 'legacy_unknown',
  add column if not exists generation_id uuid;

alter table public.fund_liabilities
  add column if not exists authority text not null default 'legacy_unknown';

-- Manual source rows are deterministically owner-authored, not provider facts.
-- Normalize them once into the manual contract. Non-manual legacy rows remain
-- legacy_unknown and locked until a provider re-verifies them.
update public.fund_holdings
set authority = 'manual',
    provider = null,
    provider_record_id = null,
    connection_id = null,
    retrieved_at = null,
    effective_at = null,
    reconciliation_state = null
where source = 'manual'
  and authority = 'legacy_unknown';

update public.fund_holdings
set generation_id = null
where authority in ('manual', 'legacy_unknown');

with connection_generations as (
  select user_id, connection_id, provider, gen_random_uuid() as generation_id
  from public.fund_holdings
  where authority = 'provider' and generation_id is null
  group by user_id, connection_id, provider
)
update public.fund_holdings holding
set generation_id = connection_generations.generation_id
from connection_generations
where holding.user_id = connection_generations.user_id
  and holding.connection_id = connection_generations.connection_id
  and holding.provider = connection_generations.provider
  and holding.authority = 'provider'
  and holding.generation_id is null;

update public.fund_liabilities
set authority = 'manual',
    provider = null,
    provider_record_id = null,
    connection_id = null,
    retrieved_at = null,
    effective_at = null,
    reconciliation_state = null,
    generation_id = null
where source = 'manual'
  and authority = 'legacy_unknown';

update public.fund_liabilities
set generation_id = null
where authority in ('manual', 'legacy_unknown');

with connection_generations as (
  select user_id, connection_id, gen_random_uuid() as generation_id
  from public.fund_liabilities
  where authority = 'provider' and generation_id is null
  group by user_id, connection_id
)
update public.fund_liabilities liability
set generation_id = connection_generations.generation_id
from connection_generations
where liability.user_id = connection_generations.user_id
  and liability.connection_id = connection_generations.connection_id
  and liability.authority = 'provider'
  and liability.generation_id is null;

alter table public.fund_holdings
  drop constraint if exists fund_holdings_authority_contract,
  add constraint fund_holdings_authority_contract check (
    (
      authority = 'legacy_unknown'
      and generation_id is null
    )
    or (
      authority = 'manual'
      and source = 'manual'
      and provider is null
      and provider_record_id is null
      and connection_id is null
      and retrieved_at is null
      and effective_at is null
      and reconciliation_state is null
      and generation_id is null
    )
    or (
      authority = 'provider'
      and source in ('plaid', 'public')
      and provider = source
      and nullif(btrim(provider_record_id), '') is not null
      and connection_id is not null
      and retrieved_at is not null
      and reconciliation_state = 'matched'
      and generation_id is not null
    )
  );

alter table public.fund_liabilities
  drop constraint if exists fund_liabilities_authority_contract,
  add constraint fund_liabilities_authority_contract check (
    (
      authority = 'legacy_unknown'
      and generation_id is null
    )
    or (
      authority = 'manual'
      and source = 'manual'
      and provider is null
      and provider_record_id is null
      and connection_id is null
      and retrieved_at is null
      and effective_at is null
      and reconciliation_state is null
      and generation_id is null
    )
    or (
      authority = 'provider'
      and source = 'plaid'
      and provider = 'plaid'
      and nullif(btrim(provider_record_id), '') is not null
      and connection_id is not null
      and retrieved_at is not null
      and reconciliation_state = 'matched'
      and generation_id is not null
    )
  );

alter table public.fund_holdings
  drop constraint if exists fund_holdings_user_id_symbol_key;
create unique index if not exists fund_holdings_manual_identity_uidx
  on public.fund_holdings (user_id, symbol)
  where authority = 'manual';
create unique index if not exists fund_holdings_provider_identity_uidx
  on public.fund_holdings (user_id, provider, connection_id, provider_record_id)
  where authority = 'provider';

do $$
begin
  if exists (
    select 1
    from public.fund_liabilities
    where authority = 'manual'
    group by user_id, kind, name
    having count(*) > 1
  ) then
    raise exception
      'financial truth migration blocked: duplicate manual liabilities require owner remediation'
      using errcode = '23505',
            hint = 'Review duplicate (user_id, kind, name) rows; preserve each money fact until the owner resolves identity.';
  end if;
end;
$$;
create unique index if not exists fund_liabilities_manual_identity_uidx
  on public.fund_liabilities (user_id, kind, name)
  where authority = 'manual';
create unique index if not exists fund_liabilities_provider_identity_uidx
  on public.fund_liabilities (user_id, provider, connection_id, provider_record_id)
  where authority = 'provider';

create or replace function public.guard_fund_holding_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked boolean;
begin
  if current_user = 'authenticated' then
    if tg_op in ('UPDATE', 'DELETE') and (
      old.authority = 'provider'
      or (old.authority = 'legacy_unknown' and old.source <> 'manual')
    ) then
      raise exception 'provider and legacy-provider holdings are server-managed'
        using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.authority := 'manual';
    new.source := 'manual';
    new.provider := null;
    new.provider_record_id := null;
    new.connection_id := null;
    new.retrieved_at := null;
    new.effective_at := null;
    new.reconciliation_state := null;
    new.generation_id := null;
    return new;
  end if;

  if current_user <> 'postgres'
    and tg_op in ('UPDATE', 'DELETE')
    and old.authority = 'provider'
    and exists (
      select 1 from public.fund_provider_coverage coverage
      where coverage.user_id = old.user_id
        and coverage.connection_id = old.connection_id
        and coverage.provider = old.provider
        and coverage.component = 'holdings'
        and coverage.complete
        and coverage.generation_id = old.generation_id
    ) then
    raise exception 'published provider holding facts are immutable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.authority = 'provider' then
    if new.retrieved_at < now() - interval '48 hours'
      or new.retrieved_at > now() + interval '1 minute' then
      raise exception 'provider holding retrieved_at is not fresh'
        using errcode = '22023';
    end if;
    if new.symbol !~ '^[A-Z][A-Z0-9.-]{0,14}$' then
      raise exception 'provider holding symbol is invalid'
        using errcode = '22023';
    end if;
    select exists (
      select 1
      from public.fund_connections c
      where c.id = new.connection_id
        and c.user_id = new.user_id
        and c.status = 'linked'
        and c.authority = 'provider_verified'
        and c.verified_at is not null
        and c.provider = new.provider
    ) into linked;
    if not linked then
      raise exception 'provider holding connection is not linked to owner'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_fund_liability_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked boolean;
begin
  if current_user = 'authenticated' then
    if tg_op in ('UPDATE', 'DELETE') and (
      old.authority = 'provider'
      or (old.authority = 'legacy_unknown' and old.source <> 'manual')
    ) then
      raise exception 'provider and legacy-provider liabilities are server-managed'
        using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.authority := 'manual';
    new.source := 'manual';
    new.provider := null;
    new.provider_record_id := null;
    new.connection_id := null;
    new.retrieved_at := null;
    new.effective_at := null;
    new.reconciliation_state := null;
    new.generation_id := null;
    return new;
  end if;

  if current_user <> 'postgres'
    and tg_op in ('UPDATE', 'DELETE')
    and old.authority = 'provider'
    and exists (
      select 1 from public.fund_provider_coverage coverage
      where coverage.user_id = old.user_id
        and coverage.connection_id = old.connection_id
        and coverage.provider = old.provider
        and coverage.component = 'liabilities'
        and coverage.complete
        and coverage.generation_id = old.generation_id
    ) then
    raise exception 'published provider liability facts are immutable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.authority = 'provider' then
    if new.retrieved_at < now() - interval '24 hours'
      or new.retrieved_at > now() + interval '1 minute' then
      raise exception 'provider liability retrieved_at is not fresh'
        using errcode = '22023';
    end if;
    select exists (
      select 1
      from public.fund_connections c
      where c.id = new.connection_id
        and c.user_id = new.user_id
        and c.status = 'linked'
        and c.authority = 'provider_verified'
        and c.verified_at is not null
        and c.provider = new.provider
    ) into linked;
    if not linked then
      raise exception 'provider liability connection is not linked to owner'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_fund_holding_authority() from public, anon, authenticated;
revoke all on function public.guard_fund_liability_authority() from public, anon, authenticated;

drop trigger if exists guard_fund_holding_authority on public.fund_holdings;
create trigger guard_fund_holding_authority
before insert or update or delete on public.fund_holdings
for each row execute function public.guard_fund_holding_authority();

drop trigger if exists guard_fund_liability_authority on public.fund_liabilities;
create trigger guard_fund_liability_authority
before insert or update or delete on public.fund_liabilities
for each row execute function public.guard_fund_liability_authority();

-- Make the authenticated role explicit in the ownership policies. Grants remain
-- a separate layer and the service role continues to bypass RLS.
drop policy if exists "fund_holdings_select_own" on public.fund_holdings;
drop policy if exists "fund_holdings_insert_own" on public.fund_holdings;
drop policy if exists "fund_holdings_update_own" on public.fund_holdings;
drop policy if exists "fund_holdings_delete_own" on public.fund_holdings;
create policy "fund_holdings_select_own" on public.fund_holdings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "fund_holdings_insert_own" on public.fund_holdings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "fund_holdings_update_own" on public.fund_holdings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "fund_holdings_delete_own" on public.fund_holdings
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "fund_liabilities_select_own" on public.fund_liabilities;
drop policy if exists "fund_liabilities_insert_own" on public.fund_liabilities;
drop policy if exists "fund_liabilities_update_own" on public.fund_liabilities;
drop policy if exists "fund_liabilities_delete_own" on public.fund_liabilities;
create policy "fund_liabilities_select_own" on public.fund_liabilities
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "fund_liabilities_insert_own" on public.fund_liabilities
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "fund_liabilities_update_own" on public.fund_liabilities
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "fund_liabilities_delete_own" on public.fund_liabilities
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Auditable, exact daily snapshots. Existing rows remain explicitly legacy.
alter table public.net_worth_snapshots
  add column if not exists authority text not null default 'legacy_unknown',
  add column if not exists snapshot_status text not null default 'legacy_unknown',
  add column if not exists currency text,
  add column if not exists calculation_version text not null default 'legacy_unknown',
  add column if not exists calculation_hash text,
  add column if not exists input_provenance jsonb,
  add column if not exists input_as_of timestamptz;

alter table public.net_worth_snapshots
  drop constraint if exists net_worth_snapshots_authority_contract,
  add constraint net_worth_snapshots_authority_contract check (
    (
      authority = 'provider'
      and snapshot_status = 'fresh'
      and currency = 'USD'
      and calculation_version = 'financial-truth-v2'
      and calculation_hash ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(input_provenance) = 'array'
      and jsonb_array_length(input_provenance) > 0
      and input_as_of is not null
      and input_as_of <= computed_at
      and scale(cash) <= 2
      and scale(invested) <= 2
      and scale(liabilities) <= 2
      and invested >= 0
      and liabilities >= 0
      and scale(net_worth) <= 2
      and net_worth = cash + invested - liabilities
    )
    or (
      authority = 'legacy_unknown'
      and snapshot_status = 'legacy_unknown'
      and currency is null
      and calculation_version = 'legacy_unknown'
      and calculation_hash is null
      and input_provenance is null
      and input_as_of is null
    )
  );

create or replace function public.guard_net_worth_snapshot_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op in ('UPDATE', 'DELETE') and old.authority = 'provider' then
      raise exception 'provider-authoritative net-worth snapshots are server-managed'
        using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.authority := 'legacy_unknown';
    new.snapshot_status := 'legacy_unknown';
    new.currency := null;
    new.calculation_version := 'legacy_unknown';
    new.calculation_hash := null;
    new.input_provenance := null;
    new.input_as_of := null;
  end if;
  if tg_op = 'UPDATE' and old.authority = 'provider' then
    if new.authority <> 'provider'
      or new.user_id is distinct from old.user_id
      or new.captured_on is distinct from old.captured_on then
      raise exception 'provider snapshot owner and captured key are immutable'
        using errcode = '23514';
    end if;
    if new.calculation_hash is not distinct from old.calculation_hash then
      if new.cash is distinct from old.cash
        or new.invested is distinct from old.invested
        or new.liabilities is distinct from old.liabilities
        or new.net_worth is distinct from old.net_worth
        or new.currency is distinct from old.currency
        or new.snapshot_status is distinct from old.snapshot_status
        or new.calculation_version is distinct from old.calculation_version
        or new.input_as_of is distinct from old.input_as_of
        or new.input_provenance is distinct from old.input_provenance then
        raise exception 'provider snapshot facts require a new calculation hash'
          using errcode = '23514';
      end if;
      -- A deterministic replay of identical facts is a no-op, including its
      -- computation timestamp. The first persisted observation remains true.
      new.computed_at := old.computed_at;
    elsif new.computed_at <= old.computed_at then
      raise exception 'provider snapshot revision time must advance'
        using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.guard_net_worth_snapshot_authority() from public, anon, authenticated;

drop trigger if exists guard_net_worth_snapshot_authority on public.net_worth_snapshots;
create trigger guard_net_worth_snapshot_authority
before insert or update or delete on public.net_worth_snapshots
for each row execute function public.guard_net_worth_snapshot_authority();

create table if not exists public.net_worth_snapshot_revisions (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.net_worth_snapshots(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  captured_on date not null,
  computed_at timestamptz not null,
  input_as_of timestamptz not null,
  calculation_version text not null,
  calculation_hash text not null check (calculation_hash ~ '^[0-9a-f]{64}$'),
  input_provenance jsonb not null check (
    jsonb_typeof(input_provenance) = 'array' and jsonb_array_length(input_provenance) > 0
  ),
  currency text not null check (currency = 'USD'),
  cash numeric not null check (scale(cash) <= 2),
  invested numeric not null check (scale(invested) <= 2 and invested >= 0),
  liabilities numeric not null check (scale(liabilities) <= 2 and liabilities >= 0),
  net_worth numeric not null check (
    scale(net_worth) <= 2 and net_worth = cash + invested - liabilities
  ),
  recorded_at timestamptz not null default now(),
  unique (snapshot_id, calculation_hash)
);
alter table public.net_worth_snapshot_revisions
  drop constraint if exists net_worth_snapshot_revisions_sign_contract,
  add constraint net_worth_snapshot_revisions_sign_contract check (
    invested >= 0 and liabilities >= 0
  );

alter table public.net_worth_snapshot_revisions enable row level security;
drop policy if exists "net_worth_snapshot_revisions_select_own"
  on public.net_worth_snapshot_revisions;
create policy "net_worth_snapshot_revisions_select_own"
  on public.net_worth_snapshot_revisions for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on table public.net_worth_snapshot_revisions from anon, authenticated;
grant select on table public.net_worth_snapshot_revisions to authenticated;
revoke all on table public.net_worth_snapshot_revisions from service_role;
grant select, insert on table public.net_worth_snapshot_revisions to service_role;

create or replace function public.reject_net_worth_revision_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'net-worth snapshot revisions are append-only'
    using errcode = '42501';
end;
$$;
revoke all on function public.reject_net_worth_revision_mutation() from public, anon, authenticated;
drop trigger if exists reject_net_worth_revision_row_mutation on public.net_worth_snapshot_revisions;
create trigger reject_net_worth_revision_row_mutation
before update or delete on public.net_worth_snapshot_revisions
for each row execute function public.reject_net_worth_revision_mutation();
drop trigger if exists reject_net_worth_revision_truncate on public.net_worth_snapshot_revisions;
create trigger reject_net_worth_revision_truncate
before truncate on public.net_worth_snapshot_revisions
for each statement execute function public.reject_net_worth_revision_mutation();

create or replace function public.audit_net_worth_snapshot_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.authority = 'provider'
    and (tg_op = 'INSERT' or old.calculation_hash is distinct from new.calculation_hash) then
    insert into public.net_worth_snapshot_revisions (
      snapshot_id, user_id, captured_on, computed_at, input_as_of,
      calculation_version, calculation_hash, input_provenance, currency,
      cash, invested, liabilities, net_worth
    ) values (
      new.id, new.user_id, new.captured_on, new.computed_at, new.input_as_of,
      new.calculation_version, new.calculation_hash, new.input_provenance, new.currency,
      new.cash, new.invested, new.liabilities, new.net_worth
    ) on conflict (snapshot_id, calculation_hash) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.audit_net_worth_snapshot_revision() from public, anon, authenticated;
drop trigger if exists audit_net_worth_snapshot_revision on public.net_worth_snapshots;
create trigger audit_net_worth_snapshot_revision
after insert or update on public.net_worth_snapshots
for each row execute function public.audit_net_worth_snapshot_revision();

drop policy if exists "net_worth_snapshots_select_own" on public.net_worth_snapshots;
drop policy if exists "net_worth_snapshots_insert_own" on public.net_worth_snapshots;
drop policy if exists "net_worth_snapshots_update_own" on public.net_worth_snapshots;
drop policy if exists "net_worth_snapshots_delete_own" on public.net_worth_snapshots;
create policy "net_worth_snapshots_select_own" on public.net_worth_snapshots
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "net_worth_snapshots_insert_own" on public.net_worth_snapshots
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "net_worth_snapshots_update_own" on public.net_worth_snapshots
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "net_worth_snapshots_delete_own" on public.net_worth_snapshots
  for delete to authenticated using ((select auth.uid()) = user_id);

create or replace view public.net_worth_snapshots_exact
with (security_invoker = true)
as
select
  id,
  user_id,
  captured_on,
  cash::text as cash,
  invested::text as invested,
  liabilities::text as liabilities,
  net_worth::text as net_worth,
  created_at,
  computed_at,
  authority,
  snapshot_status,
  currency,
  calculation_version,
  calculation_hash,
  input_as_of
from public.net_worth_snapshots;
revoke all on table public.net_worth_snapshots_exact from anon;
grant select on table public.net_worth_snapshots_exact to authenticated, service_role;

-- A Make webhook 2xx confirms only scenario acceptance. It is not evidence
-- that an email was delivered. Downgrade legacy unconfirmed rows and reserve
-- "delivered" for a future verified callback/reconciliation path.
alter table public.integration_delivery_outbox
  add column if not exists accepted_at timestamptz;

alter table public.integration_delivery_outbox
  drop constraint if exists integration_delivery_outbox_status_check,
  drop constraint if exists integration_delivery_outbox_delivered_check,
  drop constraint if exists integration_delivery_outbox_delivery_state_check;

update public.integration_delivery_outbox
set status = 'accepted',
    accepted_at = coalesce(delivered_at, updated_at),
    delivered_at = null,
    last_error_code = 'delivery_confirmation_pending'
where status = 'delivered'
  and accepted_at is null;

alter table public.integration_delivery_outbox
  add constraint integration_delivery_outbox_status_check check (
    status in ('pending', 'accepted', 'delivered', 'failed', 'dead_letter')
  ),
  add constraint integration_delivery_outbox_delivery_state_check check (
    (status = 'accepted' and accepted_at is not null and delivered_at is null)
    or (status = 'delivered' and accepted_at is not null and delivered_at is not null)
    or (status not in ('accepted', 'delivered') and delivered_at is null)
  );

grant select (
  id, provider, event_type, status, attempt_count, last_error_code,
  last_http_status, locked_at, accepted_at, delivered_at, created_at, updated_at
) on table public.integration_delivery_outbox to authenticated;

commit;
