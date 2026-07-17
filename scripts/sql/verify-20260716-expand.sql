-- Read-only hosted/local verification for the 20260716 expansion wave.
-- This intentionally asserts that legacy owner-write policies still exist:
-- the contract migration must not have run before the compatible app is live.

set statement_timeout = '30s';

do $$
declare
  v_function text;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agent_tasks'
      and column_name = 'idempotency_key'
  ) then
    raise exception 'missing expansion column agent_tasks.idempotency_key';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'routine_runs'
      and column_name = 'resume_claim_token'
  ) then
    raise exception 'missing expansion column routine_runs.resume_claim_token';
  end if;

  foreach v_function in array array[
    'public.create_agent_task_with_activity(uuid,text,jsonb,uuid,text,jsonb)',
    'public.consume_actionable_approval(uuid,uuid,timestamp with time zone)',
    'public.consume_webauthn_challenge(uuid,text,uuid,timestamp with time zone)',
    'public.commit_passkey_authentication(uuid,uuid,bigint,bigint,timestamp with time zone,timestamp with time zone)',
    'public.claim_routine_resume(uuid,uuid,uuid,integer)',
    'public.complete_routine_resume(uuid,uuid,uuid,text,jsonb,numeric)'
  ]
  loop
    if to_regprocedure(v_function) is null then
      raise exception 'missing expansion function %', v_function;
    end if;
    if not has_function_privilege('service_role', v_function, 'execute') then
      raise exception 'service_role cannot execute %', v_function;
    end if;
    if has_function_privilege('anon', v_function, 'execute')
      or has_function_privilege('authenticated', v_function, 'execute')
    then
      raise exception 'browser role can execute service-only function %', v_function;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_tasks'
      and policyname = 'agent_tasks_update_own'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'approvals'
      and policyname = 'approvals_update_own'
  ) then
    raise exception 'contract migration appears to be applied before app deployment';
  end if;

  if not has_table_privilege(
    'authenticated',
    'public.agent_tasks',
    'update'
  ) or not has_table_privilege(
    'authenticated',
    'public.approvals',
    'update'
  ) then
    raise exception 'legacy application write grant is missing before app deployment';
  end if;
end
$$;

reset statement_timeout;
