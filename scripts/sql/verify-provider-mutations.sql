-- Phase 1A contract read-back. This is deliberately read-only except for the
-- transaction-scoped effective-role probes, which always roll back.
set statement_timeout = '30s';
do $$
declare f text;
begin
  foreach f in array array[
    'public.prepare_provider_mutation_command(uuid,text,text,text,text,text,text,uuid,text,uuid)',
    'public.claim_provider_mutation_command(uuid,integer)',
    'public.complete_provider_mutation_command(uuid,integer,text,text,integer)',
    'public.fail_provider_mutation_before_dispatch(uuid,integer,text)',
    'public.mark_provider_mutation_outcome_unknown(uuid,integer,text)',
    'public.mark_provider_mutation_reconciliation_required(uuid,integer,text,text,text,integer)',
    'public.reconcile_provider_mutation_command(uuid,integer,text,text,integer)',
    'public.delete_local_schedule_event(uuid,uuid)'
  ] loop
    if to_regprocedure(f) is null or not has_function_privilege('service_role', f, 'execute')
      or has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'service-only mutation RPC contract failed for %', f;
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid='public.provider_mutation_commands'::regclass and conname like '%idempotency%')
    or not exists (select 1 from pg_trigger where tgrelid='public.provider_mutation_commands'::regclass and tgname='provider_mutation_commands_transition_guard' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgrelid='public.provider_mutation_receipts'::regclass and tgname='provider_mutation_receipts_append_only' and not tgisinternal) then
    raise exception 'idempotency, CAS, or append-only invariant missing';
  end if;
  if has_table_privilege('authenticated','public.provider_mutation_commands','insert')
    or has_table_privilege('authenticated','public.provider_mutation_receipts','insert')
    or has_table_privilege('authenticated','public.schedule_events','delete')
    or has_column_privilege('authenticated','public.schedule_events','gcal_event_id','update')
    or has_column_privilege('authenticated','public.schedule_events','outlook_event_id','update') then
    raise exception 'browser provider authority remains after contract';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='schedule_events' and policyname='schedule_events_select_own' and qual ilike '%deleted_at%is null%') then
    raise exception 'tombstones are not hidden from owner reads';
  end if;
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin
  begin
    execute 'insert into public.provider_mutation_commands default values';
    raise exception 'browser command insert unexpectedly succeeded';
  exception when insufficient_privilege then null; when others then raise exception 'browser command insert reached authority table: %', sqlerrm; end;
  begin
    execute 'delete from public.schedule_events where id = ''00000000-0000-4000-8000-000000000001''';
    raise exception 'browser calendar delete unexpectedly succeeded';
  exception when insufficient_privilege then null; when others then raise exception 'browser calendar delete reached authority table: %', sqlerrm; end;
end $$;
rollback;
reset statement_timeout;
