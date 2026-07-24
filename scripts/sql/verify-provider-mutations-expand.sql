-- Phase 1A expansion read-back. Run after 20260723183000 and before 20260723183001.
set statement_timeout = '30s';
do $$
declare f text;
begin
  if to_regclass('public.provider_mutation_commands') is null or to_regclass('public.provider_mutation_receipts') is null then
    raise exception 'provider-mutation expansion tables are missing';
  end if;
  foreach f in array array[
    'public.prepare_provider_mutation_command(uuid,text,text,text,text,text,text,uuid,text,uuid)',
    'public.claim_provider_mutation_command(uuid,integer)',
    'public.complete_provider_mutation_command(uuid,integer,text,text,integer)',
    'public.fail_provider_mutation_before_dispatch(uuid,integer,text)',
    'public.mark_provider_mutation_outcome_unknown(uuid,integer,text)',
    'public.reconcile_provider_mutation_command(uuid,integer,text,text,integer)'
  ] loop
    if to_regprocedure(f) is null or not has_function_privilege('service_role', f, 'execute')
      or has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'invalid expansion RPC grant for %', f;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.provider_mutation_commands', 'insert')
    or has_table_privilege('authenticated', 'public.provider_mutation_receipts', 'insert') then
    raise exception 'browser can write provider-mutation authority during expansion';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.provider_mutation_commands'::regclass and tgname='provider_mutation_commands_transition_guard' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgrelid='public.provider_mutation_receipts'::regclass and tgname='provider_mutation_receipts_append_only' and not tgisinternal) then
    raise exception 'CAS or append-only guard missing';
  end if;
  if has_table_privilege('authenticated', 'public.schedule_events', 'delete')
    or not has_column_privilege('authenticated', 'public.schedule_events', 'gcal_event_id', 'update') then
    raise exception 'Schedule expansion grants do not preserve baseline authority';
  end if;
end $$;
reset statement_timeout;
