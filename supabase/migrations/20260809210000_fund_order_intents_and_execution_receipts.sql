-- FIN-004: order intent is not execution.
--
-- The browser may read its own intent/receipt/execution history, but only the
-- server may create an immutable intent and only a service-role reconciliation
-- boundary may materialize a provider-verified fill as fund_transactions.

create table if not exists public.fund_order_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider = 'public'),
  action_class text not null check (action_class = 'FINANCIAL_EXECUTION'),
  idempotency_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  symbol text not null check (symbol = upper(btrim(symbol)) and length(symbol) between 1 and 12),
  side text not null check (side in ('buy', 'sell')),
  order_type text not null check (order_type in ('market', 'limit')),
  quantity_units bigint not null check (quantity_units > 0),
  quantity_scale integer not null check (quantity_scale = 1000000),
  limit_price_minor bigint check (limit_price_minor > 0),
  reference_price_minor bigint check (reference_price_minor >= 0),
  reference_price_source text not null
    check (reference_price_source in ('manual_estimate', 'unavailable')),
  estimated_notional_minor bigint check (estimated_notional_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status = 'not_submitted'),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (id, user_id),
  check ((order_type = 'limit') = (limit_price_minor is not null)),
  check ((reference_price_minor is null) = (reference_price_source = 'unavailable')),
  check ((reference_price_minor is null) = (estimated_notional_minor is null)),
  check (
    estimated_notional_minor is null
    or estimated_notional_minor = round(
      quantity_units::numeric * reference_price_minor::numeric / quantity_scale
    )::bigint
  )
);

alter table public.fund_order_intents enable row level security;
drop policy if exists "fund_order_intents_select_own" on public.fund_order_intents;
create policy "fund_order_intents_select_own"
  on public.fund_order_intents for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on table public.fund_order_intents from public, anon, authenticated;
grant select on table public.fund_order_intents to authenticated;
grant all on table public.fund_order_intents to service_role;

create table if not exists public.fund_execution_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  intent_id uuid not null,
  provider text not null check (provider = 'public'),
  provider_account_ref_hash text not null check (provider_account_ref_hash ~ '^[0-9a-f]{64}$'),
  provider_order_id text not null check (length(btrim(provider_order_id)) between 1 and 512),
  provider_fill_id text not null check (length(btrim(provider_fill_id)) between 1 and 512),
  receipt_hash text not null check (receipt_hash ~ '^[0-9a-f]{64}$'),
  filled_quantity_units bigint not null check (filled_quantity_units > 0),
  quantity_scale integer not null check (quantity_scale = 1000000),
  price_minor bigint not null check (price_minor >= 0),
  gross_amount_minor bigint not null check (gross_amount_minor >= 0),
  fee_minor bigint not null check (fee_minor >= 0),
  currency text not null check (currency = 'USD'),
  executed_at timestamptz not null,
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (provider, provider_account_ref_hash, provider_fill_id),
  unique (receipt_hash),
  foreign key (intent_id, user_id)
    references public.fund_order_intents (id, user_id) on delete restrict,
  check (
    gross_amount_minor = round(
      filled_quantity_units::numeric * price_minor::numeric / quantity_scale
    )::bigint
  )
);

alter table public.fund_execution_receipts enable row level security;
drop policy if exists "fund_execution_receipts_select_own" on public.fund_execution_receipts;
create policy "fund_execution_receipts_select_own"
  on public.fund_execution_receipts for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on table public.fund_execution_receipts from public, anon, authenticated;
grant select on table public.fund_execution_receipts to authenticated;
grant all on table public.fund_execution_receipts to service_role;

create or replace function public.reject_fund_execution_receipt_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'verified execution receipts are immutable' using errcode = '55000';
end;
$$;
revoke all on function public.reject_fund_execution_receipt_mutation() from public, anon, authenticated;
drop trigger if exists reject_fund_execution_receipt_row_mutation on public.fund_execution_receipts;
create trigger reject_fund_execution_receipt_row_mutation
before update or delete on public.fund_execution_receipts
for each row execute function public.reject_fund_execution_receipt_mutation();
drop trigger if exists reject_fund_execution_receipt_truncate on public.fund_execution_receipts;
create trigger reject_fund_execution_receipt_truncate
before truncate on public.fund_execution_receipts
for each statement execute function public.reject_fund_execution_receipt_mutation();

alter table public.fund_transactions
  add column if not exists execution_authority text not null default 'legacy_unverified',
  add column if not exists order_intent_id uuid,
  add column if not exists execution_receipt_id uuid,
  add column if not exists provider_receipt_hash text;

alter table public.fund_transactions
  drop constraint if exists fund_transactions_execution_authority_contract,
  add constraint fund_transactions_execution_authority_contract check (
    (
      execution_authority = 'provider_verified'
      and source = 'public'
      and kind in ('buy', 'sell')
      and order_intent_id is not null
      and execution_receipt_id is not null
      and nullif(btrim(provider_record_id), '') is not null
      and provider_receipt_hash ~ '^[0-9a-f]{64}$'
      and retrieved_at is not null
      and reconciliation_state = 'matched'
    )
    or (
      execution_authority in ('legacy_unverified', 'manual_declared')
      and order_intent_id is null
      and execution_receipt_id is null
      and provider_receipt_hash is null
    )
  );

alter table public.fund_transactions
  drop constraint if exists fund_transactions_order_intent_owner_fkey,
  add constraint fund_transactions_order_intent_owner_fkey
    foreign key (order_intent_id, user_id)
    references public.fund_order_intents (id, user_id) on delete restrict,
  drop constraint if exists fund_transactions_execution_receipt_owner_fkey,
  add constraint fund_transactions_execution_receipt_owner_fkey
    foreign key (execution_receipt_id, user_id)
    references public.fund_execution_receipts (id, user_id) on delete restrict;

create unique index if not exists idx_fund_transactions_execution_receipt
  on public.fund_transactions (execution_receipt_id)
  where execution_receipt_id is not null;

create or replace function public.guard_fund_transaction_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  receipt public.fund_execution_receipts%rowtype;
  intent public.fund_order_intents%rowtype;
  expected_amount numeric;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.execution_authority = 'provider_verified' then
    raise exception 'provider-verified executions are immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and new.execution_authority = 'provider_verified' then
    raise exception 'provider-verified executions must be inserted from a receipt' using errcode = '55000';
  end if;
  if new.execution_authority <> 'provider_verified' then
    return new;
  end if;

  select * into receipt
  from public.fund_execution_receipts
  where id = new.execution_receipt_id and user_id = new.user_id;
  if not found then
    raise exception 'verified execution receipt missing' using errcode = '23503';
  end if;
  select * into intent
  from public.fund_order_intents
  where id = new.order_intent_id and user_id = new.user_id;
  if not found or receipt.intent_id <> intent.id then
    raise exception 'execution intent mismatch' using errcode = '23514';
  end if;
  expected_amount := case intent.side
    when 'buy' then -(receipt.gross_amount_minor + receipt.fee_minor)::numeric / 100
    else (receipt.gross_amount_minor - receipt.fee_minor)::numeric / 100
  end;
  if new.kind <> intent.side
    or new.symbol <> intent.symbol
    or new.shares <> receipt.filled_quantity_units::numeric / receipt.quantity_scale
    or new.price <> receipt.price_minor::numeric / 100
    or new.fee <> receipt.fee_minor::numeric / 100
    or new.amount <> expected_amount
    or new.currency <> receipt.currency
    or new.executed_at <> receipt.executed_at
    or new.retrieved_at <> receipt.retrieved_at
    or new.provider_record_id <> receipt.provider_fill_id
    or new.provider_receipt_hash <> receipt.receipt_hash then
    raise exception 'execution does not match verified receipt' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_fund_transaction_execution() from public, anon, authenticated;
drop trigger if exists guard_fund_transaction_execution on public.fund_transactions;
create trigger guard_fund_transaction_execution
before insert or update or delete on public.fund_transactions
for each row execute function public.guard_fund_transaction_execution();

-- Existing transactions remain readable but explicitly unverified. Browser DML
-- is removed; new provider executions can only be materialized by the service
-- function below after an immutable fill receipt is present.
drop policy if exists "fund_transactions_insert_own" on public.fund_transactions;
drop policy if exists "fund_transactions_update_own" on public.fund_transactions;
drop policy if exists "fund_transactions_delete_own" on public.fund_transactions;
revoke insert, update, delete, truncate on table public.fund_transactions from authenticated;
grant select on table public.fund_transactions to authenticated;

create or replace function public.record_verified_fund_execution(
  p_user_id uuid,
  p_intent_id uuid,
  p_provider_account_ref_hash text,
  p_provider_order_id text,
  p_provider_fill_id text,
  p_receipt_hash text,
  p_filled_quantity_units bigint,
  p_price_minor bigint,
  p_fee_minor bigint,
  p_executed_at timestamptz,
  p_retrieved_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent public.fund_order_intents%rowtype;
  receipt public.fund_execution_receipts%rowtype;
  transaction_row public.fund_transactions%rowtype;
  gross_minor bigint;
  signed_amount numeric;
  inserted_receipt boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_account_ref_hash !~ '^[0-9a-f]{64}$'
    or p_receipt_hash !~ '^[0-9a-f]{64}$'
    or p_filled_quantity_units <= 0
    or p_price_minor < 0
    or p_fee_minor < 0
    or p_executed_at is null
    or p_retrieved_at is null then
    raise exception 'invalid verified receipt' using errcode = '22023';
  end if;

  select * into intent from public.fund_order_intents
  where id = p_intent_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  gross_minor := round(
    p_filled_quantity_units::numeric * p_price_minor::numeric / intent.quantity_scale
  )::bigint;

  insert into public.fund_execution_receipts (
    user_id, intent_id, provider, provider_account_ref_hash,
    provider_order_id, provider_fill_id, receipt_hash,
    filled_quantity_units, quantity_scale, price_minor, gross_amount_minor,
    fee_minor, currency, executed_at, retrieved_at
  ) values (
    p_user_id, intent.id, intent.provider, p_provider_account_ref_hash,
    btrim(p_provider_order_id), btrim(p_provider_fill_id), p_receipt_hash,
    p_filled_quantity_units, intent.quantity_scale, p_price_minor, gross_minor,
    p_fee_minor, intent.currency, p_executed_at, p_retrieved_at
  )
  on conflict (provider, provider_account_ref_hash, provider_fill_id) do nothing
  returning * into receipt;
  inserted_receipt := found;

  if not inserted_receipt then
    select * into receipt from public.fund_execution_receipts
    where provider = intent.provider
      and provider_account_ref_hash = p_provider_account_ref_hash
      and provider_fill_id = btrim(p_provider_fill_id);
    if not found
      or receipt.user_id <> p_user_id
      or receipt.intent_id <> intent.id
      or receipt.provider_order_id <> btrim(p_provider_order_id)
      or receipt.receipt_hash <> p_receipt_hash
      or receipt.filled_quantity_units <> p_filled_quantity_units
      or receipt.price_minor <> p_price_minor
      or receipt.fee_minor <> p_fee_minor
      or receipt.executed_at <> p_executed_at then
      return jsonb_build_object('outcome', 'conflict');
    end if;
  end if;

  signed_amount := case intent.side
    when 'buy' then -(receipt.gross_amount_minor + receipt.fee_minor)::numeric / 100
    else (receipt.gross_amount_minor - receipt.fee_minor)::numeric / 100
  end;
  insert into public.fund_transactions (
    user_id, kind, symbol, name, shares, price, amount, fee, source,
    executed_at, provider_record_id, retrieved_at, currency,
    reconciliation_state, execution_authority, order_intent_id,
    execution_receipt_id, provider_receipt_hash
  ) values (
    p_user_id, intent.side, intent.symbol, intent.symbol,
    receipt.filled_quantity_units::numeric / receipt.quantity_scale,
    receipt.price_minor::numeric / 100, signed_amount,
    receipt.fee_minor::numeric / 100, 'public', receipt.executed_at,
    receipt.provider_fill_id, receipt.retrieved_at, receipt.currency, 'matched',
    'provider_verified', intent.id, receipt.id, receipt.receipt_hash
  )
  on conflict (execution_receipt_id) where execution_receipt_id is not null do nothing
  returning * into transaction_row;

  if not found then
    select * into transaction_row from public.fund_transactions
    where execution_receipt_id = receipt.id;
  end if;
  return jsonb_build_object(
    'outcome', case when inserted_receipt then 'created' else 'deduplicated' end,
    'receiptId', receipt.id,
    'transactionId', transaction_row.id
  );
end;
$$;
revoke all on function public.record_verified_fund_execution(
  uuid, uuid, text, text, text, text, bigint, bigint, bigint, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_verified_fund_execution(
  uuid, uuid, text, text, text, text, bigint, bigint, bigint, timestamptz, timestamptz
) to service_role;

