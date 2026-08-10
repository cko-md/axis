-- FIN-003 / FIN-004 strict post-application contract.
--
-- Apply only after the compatible application is Ready, legacy workers are
-- drained, and the live application SHA plus recovery owner are recorded in
-- the release evidence. This migration fabricates no provider lineage.

begin;

-- Expansion-only writers must be gone before the strict contract publishes.
drop trigger if exists guard_fund_connection_expansion_compatibility
  on public.fund_connections;
drop function if exists public.guard_fund_connection_expansion_compatibility();

drop trigger if exists guard_make_outbox_expansion_compatibility
  on public.integration_delivery_outbox;
drop function if exists public.guard_make_outbox_expansion_compatibility();

-- Preserve invalid legacy facts for service-only audit, then remove them from
-- the user-visible truth table. Missing provider lineage is never inferred.
create table if not exists public.fund_recurring_lineage_quarantine (
  recurring_transaction_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  row_payload jsonb not null,
  quarantine_reason text not null
    check (quarantine_reason = 'missing_authoritative_provider_lineage'),
  quarantined_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.fund_recurring_lineage_quarantine enable row level security;
revoke all on table public.fund_recurring_lineage_quarantine
  from public, anon, authenticated, service_role;
grant select on table public.fund_recurring_lineage_quarantine to service_role;

insert into public.fund_recurring_lineage_quarantine (
  recurring_transaction_id,
  user_id,
  row_payload,
  quarantine_reason
)
select
  recurring.id,
  recurring.user_id,
  pg_catalog.to_jsonb(recurring),
  'missing_authoritative_provider_lineage'
from public.fund_recurring_transactions recurring
where recurring.source = 'detected'
  and (
    recurring.source_generations is null
    or recurring.source_generation_hash is null
    or pg_catalog.jsonb_typeof(recurring.source_generations) <> 'array'
    or pg_catalog.jsonb_array_length(recurring.source_generations) = 0
    or recurring.source_generation_hash !~ '^[0-9a-f]{64}$'
  )
on conflict (recurring_transaction_id) do nothing;

delete from public.fund_recurring_transactions recurring
where recurring.source = 'detected'
  and (
    recurring.source_generations is null
    or recurring.source_generation_hash is null
    or pg_catalog.jsonb_typeof(recurring.source_generations) <> 'array'
    or pg_catalog.jsonb_array_length(recurring.source_generations) = 0
    or recurring.source_generation_hash !~ '^[0-9a-f]{64}$'
  );

do $$
begin
  if exists (
    select 1
    from public.fund_recurring_transactions recurring
    where recurring.source = 'detected'
      and (
        recurring.source_generations is null
        or recurring.source_generation_hash is null
        or pg_catalog.jsonb_typeof(recurring.source_generations) <> 'array'
        or pg_catalog.jsonb_array_length(recurring.source_generations) = 0
        or recurring.source_generation_hash !~ '^[0-9a-f]{64}$'
      )
  ) then
    raise exception 'lineage-less detected recurring rows remain after quarantine'
      using errcode = '23514';
  end if;
end;
$$;

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
        and source_generations is not null
        and source_generation_hash is not null
        and pg_catalog.jsonb_typeof(source_generations) = 'array'
        and pg_catalog.jsonb_array_length(source_generations) > 0
        and source_generation_hash ~ '^[0-9a-f]{64}$'
      )
    )
  );

-- Reassert the service-only detected-fact publication boundary without the
-- expansion-era lineage-less branch.
create or replace function public.guard_fund_recurring_transaction_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  coverage_available boolean;
  coverage_lineage jsonb;
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
    select verified.available, verified.coverage, verified.lineage_hash
    into coverage_available, coverage_lineage, coverage_hash
    from public.check_fund_transaction_history_coverage(
      new.user_id,
      (current_date - 90)::date,
      current_date
    ) verified;
    if coverage_available is distinct from true
      or new.source_generations is distinct from coverage_lineage
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

-- The currency/source-aware arbiters must already be valid before the legacy
-- narrower uniqueness constraints are removed.
do $$
declare
  required_index text;
begin
  foreach required_index in array array[
    'fund_category_budgets_identity_uidx',
    'fund_bank_transactions_provider_identity_uidx',
    'fund_bank_transactions_manual_identity_uidx',
    'fund_recurring_transactions_identity_uidx',
    'fund_holdings_manual_identity_uidx',
    'fund_holdings_provider_identity_uidx'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_class index_class
      join pg_catalog.pg_index index_row on index_row.indexrelid = index_class.oid
      join pg_catalog.pg_namespace namespace on namespace.oid = index_class.relnamespace
      where namespace.nspname = 'public'
        and index_class.relname = required_index
        and index_row.indisunique
        and index_row.indisvalid
    ) then
      raise exception 'required financial identity index is not valid: %', required_index
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

alter table public.fund_category_budgets
  drop constraint if exists fund_category_budgets_user_id_category_key;
alter table public.fund_bank_transactions
  drop constraint if exists fund_bank_transactions_user_id_plaid_transaction_id_key;
alter table public.fund_recurring_transactions
  drop constraint if exists fund_recurring_transactions_user_merchant_uniq;
alter table public.fund_holdings
  drop constraint if exists fund_holdings_user_id_symbol_key;

-- Browser clients retain only owner-filtered display access to connections and
-- transactions. Credential mutation and verified execution remain server-only.
drop policy if exists "fund_connections_insert_own" on public.fund_connections;
drop policy if exists "fund_connections_update_own" on public.fund_connections;
drop policy if exists "fund_connections_delete_own" on public.fund_connections;
revoke all on table public.fund_connections from authenticated;
revoke select (item_id, access_token_enc, refresh_token_enc)
  on table public.fund_connections from authenticated;
grant select (
  id, user_id, provider, institution, mask, status, authority, verified_at,
  action_required, provider_event_at, created_at, updated_at
) on table public.fund_connections to authenticated;

drop policy if exists "fund_transactions_insert_own" on public.fund_transactions;
drop policy if exists "fund_transactions_update_own" on public.fund_transactions;
drop policy if exists "fund_transactions_delete_own" on public.fund_transactions;
revoke all on table public.fund_transactions from authenticated, service_role;
grant select on table public.fund_transactions to authenticated, service_role;

commit;
