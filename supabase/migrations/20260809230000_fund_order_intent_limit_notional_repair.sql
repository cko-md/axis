-- FIN-004 repair: a limit order's immutable notional is derived from its
-- limit price, not an optional reference quote. The original migration is
-- already ledgered and remains immutable; this additive migration replaces
-- only the affected checks.

begin;

do $$
begin
  if exists (
    select 1
    from public.fund_order_intents
    where order_type = 'limit'
      and (
        estimated_notional_minor is null
        or estimated_notional_minor <> round(
          quantity_units::numeric * limit_price_minor::numeric / quantity_scale
        )::bigint
      )
  ) then
    raise exception using
      errcode = 'check_violation',
      message = 'FIN_ORDER_INTENT_PREFLIGHT_FAILED',
      detail = 'Existing immutable limit intents disagree with limit-price notional; quarantine and review them before applying this migration.';
  end if;
end;
$$;

do $$
declare
  affected record;
begin
  for affected in
    select conname
    from pg_constraint
    where conrelid = 'public.fund_order_intents'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%estimated_notional_minor%'
  loop
    execute format(
      'alter table public.fund_order_intents drop constraint %I',
      affected.conname
    );
  end loop;
end;
$$;

alter table public.fund_order_intents
  add constraint fund_order_intents_estimated_notional_nonnegative
    check (estimated_notional_minor >= 0),
  add constraint fund_order_intents_estimated_notional_presence
    check (
      (
        order_type = 'limit'
        and estimated_notional_minor is not null
      )
      or (
        order_type = 'market'
        and ((reference_price_minor is null) = (estimated_notional_minor is null))
      )
    ),
  add constraint fund_order_intents_estimated_notional_calculation
    check (
      estimated_notional_minor is null
      or estimated_notional_minor = round(
        quantity_units::numeric
        * case
            when order_type = 'limit' then limit_price_minor::numeric
            else reference_price_minor::numeric
          end
        / quantity_scale
      )::bigint
    );

commit;
