-- FIN-004: order intent is not execution.
--
-- The browser may read its own intent/receipt/execution history, but only the
-- server may create an immutable intent and only a service-role reconciliation
-- boundary may materialize a provider-verified fill as fund_transactions.

begin;

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
revoke all on table public.fund_order_intents from service_role;
grant select, insert on table public.fund_order_intents to service_role;

create or replace function public.reject_fund_order_intent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'order intents are immutable' using errcode = '55000';
end;
$$;
revoke all on function public.reject_fund_order_intent_mutation() from public, anon, authenticated;
drop trigger if exists reject_fund_order_intent_row_mutation on public.fund_order_intents;
create trigger reject_fund_order_intent_row_mutation
before update or delete on public.fund_order_intents
for each row execute function public.reject_fund_order_intent_mutation();
drop trigger if exists reject_fund_order_intent_truncate on public.fund_order_intents;
create trigger reject_fund_order_intent_truncate
before truncate on public.fund_order_intents
for each statement execute function public.reject_fund_order_intent_mutation();

-- Live submission is deliberately absent in this phase. This immutable table
-- defines the evidence a future provider adapter must create atomically after
-- consuming an exact FINANCIAL_EXECUTION approval. No current role can insert
-- a submission row, so an intent cannot become execution authority today.
create table if not exists public.fund_order_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  intent_id uuid not null,
  approval_id uuid not null,
  connection_id uuid not null,
  provider text not null check (provider = 'public'),
  provider_account_ref_hash text not null check (provider_account_ref_hash ~ '^[0-9a-f]{64}$'),
  provider_order_id text not null check (length(btrim(provider_order_id)) between 1 and 512),
  submission_hash text not null check (submission_hash ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz not null,
  acknowledged_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (intent_id),
  unique (approval_id),
  unique (provider, provider_account_ref_hash, provider_order_id),
  unique (submission_hash),
  foreign key (intent_id, user_id)
    references public.fund_order_intents (id, user_id) on delete restrict,
  foreign key (approval_id, user_id)
    references public.approvals (id, user_id) on delete restrict,
  foreign key (connection_id)
    references public.fund_connections (id) on delete restrict,
  check (submitted_at >= created_at - interval '1 minute'),
  check (acknowledged_at >= submitted_at)
);

alter table public.fund_order_submissions enable row level security;
drop policy if exists "fund_order_submissions_select_own" on public.fund_order_submissions;
create policy "fund_order_submissions_select_own"
  on public.fund_order_submissions for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on table public.fund_order_submissions from public, anon, authenticated, service_role;
grant select on table public.fund_order_submissions to authenticated, service_role;

create or replace function public.reject_fund_order_submission_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'provider order submissions are immutable' using errcode = '55000';
end;
$$;
revoke all on function public.reject_fund_order_submission_mutation() from public, anon, authenticated;
drop trigger if exists reject_fund_order_submission_row_mutation on public.fund_order_submissions;
create trigger reject_fund_order_submission_row_mutation
before update or delete on public.fund_order_submissions
for each row execute function public.reject_fund_order_submission_mutation();
drop trigger if exists reject_fund_order_submission_truncate on public.fund_order_submissions;
create trigger reject_fund_order_submission_truncate
before truncate on public.fund_order_submissions
for each statement execute function public.reject_fund_order_submission_mutation();

create table if not exists public.fund_execution_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  intent_id uuid not null,
  submission_id uuid not null,
  provider text not null check (provider = 'public'),
  provider_account_ref_hash text not null check (provider_account_ref_hash ~ '^[0-9a-f]{64}$'),
  provider_order_id text not null check (length(btrim(provider_order_id)) between 1 and 512),
  provider_fill_id text not null check (length(btrim(provider_fill_id)) between 1 and 512),
  receipt_hash text not null check (receipt_hash ~ '^[0-9a-f]{64}$'),
  filled_quantity_units bigint not null check (filled_quantity_units > 0),
  quantity_scale integer not null check (quantity_scale = 1000000),
  price_minor bigint not null check (price_minor > 0),
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
  foreign key (submission_id, user_id)
    references public.fund_order_submissions (id, user_id) on delete restrict,
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
revoke all on table public.fund_execution_receipts from service_role;
grant select on table public.fund_execution_receipts to service_role;

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
revoke insert, update, delete, truncate on table public.fund_transactions from service_role;
grant select on table public.fund_transactions to service_role;

create or replace function public.record_verified_fund_execution(
  p_user_id uuid,
  p_submission_id uuid,
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
  submission public.fund_order_submissions%rowtype;
  intent public.fund_order_intents%rowtype;
  approval public.approvals%rowtype;
  connection public.fund_connections%rowtype;
  receipt public.fund_execution_receipts%rowtype;
  transaction_row public.fund_transactions%rowtype;
  existing_fill_units numeric;
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
    or p_price_minor <= 0
    or p_fee_minor < 0
    or p_executed_at is null
    or p_retrieved_at is null then
    raise exception 'invalid verified receipt' using errcode = '22023';
  end if;

  -- The submission row is intentionally uncreatable in this phase. A future
  -- live adapter must add one canonical approval-consuming submission RPC;
  -- receipt materialization stays fail-closed until that separate review.
  select * into submission
  from public.fund_order_submissions
  where id = p_submission_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into intent
  from public.fund_order_intents
  where id = submission.intent_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'conflict');
  end if;
  select * into approval
  from public.approvals
  where id = submission.approval_id and user_id = p_user_id;
  if not found
    or approval.action_class <> 'FINANCIAL_EXECUTION'
    or approval.requirement <> 'approval_step_up'
    or approval.status <> 'executed'
    or approval.step_up_verified_at is null
    or approval.proposed_action ->> 'intentId' is distinct from intent.id::text then
    return jsonb_build_object('outcome', 'approval_not_actionable');
  end if;
  select * into connection
  from public.fund_connections
  where id = submission.connection_id
    and user_id = p_user_id
    and provider = 'public'
    and status = 'linked'
    and authority = 'provider_verified';
  if not found
    or connection.item_id is null
    or encode(extensions.digest(connection.item_id, 'sha256'), 'hex')
      <> submission.provider_account_ref_hash
    or approval.proposed_action #>> '{target,accountId}' is distinct from connection.item_id
    or submission.provider_account_ref_hash <> p_provider_account_ref_hash
    or submission.provider_order_id <> btrim(p_provider_order_id)
    or submission.provider <> intent.provider
    or submission.submitted_at < intent.created_at
    or submission.acknowledged_at < submission.submitted_at then
    return jsonb_build_object('outcome', 'submission_not_authoritative');
  end if;
  if p_executed_at < submission.acknowledged_at
    or p_retrieved_at < p_executed_at
    or p_retrieved_at > clock_timestamp() + interval '1 minute' then
    return jsonb_build_object('outcome', 'invalid_chronology');
  end if;
  if intent.order_type = 'limit' and (
    (intent.side = 'buy' and p_price_minor > intent.limit_price_minor)
    or (intent.side = 'sell' and p_price_minor < intent.limit_price_minor)
  ) then
    return jsonb_build_object('outcome', 'limit_price_violated');
  end if;

  select * into receipt
  from public.fund_execution_receipts
  where provider = intent.provider
    and provider_account_ref_hash = p_provider_account_ref_hash
    and provider_fill_id = btrim(p_provider_fill_id);
  if found then
    if receipt.user_id <> p_user_id
      or receipt.intent_id <> intent.id
      or receipt.submission_id <> submission.id
      or receipt.provider_order_id <> submission.provider_order_id
      or receipt.receipt_hash <> p_receipt_hash
      or receipt.filled_quantity_units <> p_filled_quantity_units
      or receipt.price_minor <> p_price_minor
      or receipt.fee_minor <> p_fee_minor
      or receipt.executed_at <> p_executed_at
      or receipt.retrieved_at <> p_retrieved_at then
      return jsonb_build_object('outcome', 'conflict');
    end if;
    select * into transaction_row from public.fund_transactions
    where execution_receipt_id = receipt.id;
    return jsonb_build_object(
      'outcome', 'deduplicated',
      'receiptId', receipt.id,
      'transactionId', transaction_row.id
    );
  end if;

  select coalesce(sum(filled_quantity_units), 0)
  into existing_fill_units
  from public.fund_execution_receipts
  where intent_id = intent.id;
  if existing_fill_units + p_filled_quantity_units > intent.quantity_units then
    return jsonb_build_object('outcome', 'quantity_exceeded');
  end if;

  gross_minor := round(
    p_filled_quantity_units::numeric * p_price_minor::numeric / intent.quantity_scale
  )::bigint;

  insert into public.fund_execution_receipts (
    user_id, intent_id, submission_id, provider, provider_account_ref_hash,
    provider_order_id, provider_fill_id, receipt_hash,
    filled_quantity_units, quantity_scale, price_minor, gross_amount_minor,
    fee_minor, currency, executed_at, retrieved_at
  ) values (
    p_user_id, intent.id, submission.id, intent.provider, p_provider_account_ref_hash,
    btrim(p_provider_order_id), btrim(p_provider_fill_id), p_receipt_hash,
    p_filled_quantity_units, intent.quantity_scale, p_price_minor, gross_minor,
    p_fee_minor, intent.currency, p_executed_at, p_retrieved_at
  )
  on conflict do nothing
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
      or receipt.submission_id <> submission.id
      or receipt.provider_order_id <> submission.provider_order_id
      or receipt.receipt_hash <> p_receipt_hash
      or receipt.filled_quantity_units <> p_filled_quantity_units
      or receipt.price_minor <> p_price_minor
      or receipt.fee_minor <> p_fee_minor
      or receipt.executed_at <> p_executed_at
      or receipt.retrieved_at <> p_retrieved_at then
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

-- Expansion/application compatibility boundary.
-- Protected main still records a clearly unverified local transaction from
-- the old order-ticket UI. Preserve only owner-scoped legacy/manual DML until
-- the compatible intent-only application revision is Ready in production.
-- The provider-verified guard above remains active, so this temporary path can
-- never manufacture a verified execution. The subsequent contract migration
-- drops these policies and revokes browser transaction DML.
create policy "fund_transactions_insert_own"
  on public.fund_transactions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "fund_transactions_update_own"
  on public.fund_transactions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "fund_transactions_delete_own"
  on public.fund_transactions for delete to authenticated
  using ((select auth.uid()) = user_id);
grant insert, update, delete on table public.fund_transactions to authenticated;

commit;
