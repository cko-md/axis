-- FIN-004 follow-up: preserve direct immutability while honoring the declared
-- auth.users -> fund_order_intents account-deletion cascade.
--
-- A direct DELETE still reaches this trigger at depth 1 and is rejected. The
-- foreign-key action initiated by deleting the owning auth.users row reaches
-- it at a nested trigger depth and may remove a not-submitted intent. Submitted
-- or executed histories remain retained because their owner foreign keys are
-- deliberately ON DELETE RESTRICT.

begin;

create or replace function public.reject_fund_order_intent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1 then
    return old;
  end if;

  raise exception 'order intents are immutable' using errcode = '55000';
end;
$$;

revoke all on function public.reject_fund_order_intent_mutation()
  from public, anon, authenticated;

commit;
