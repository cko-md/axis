-- Read-only verification after the compatible production app is live and the
-- 202607161401 contract migration has been applied.

set statement_timeout = '30s';

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and (
        (tablename = 'agent_tasks' and policyname in (
          'agent_tasks_insert_own',
          'agent_tasks_update_own',
          'agent_tasks_delete_own'
        ))
        or (tablename = 'agent_task_activity' and policyname = 'agent_task_activity_insert_own')
        or (tablename = 'approvals' and policyname in (
          'approvals_insert_own',
          'approvals_update_own'
        ))
      )
  ) then
    raise exception 'legacy browser-write policy remains after contract';
  end if;

  if has_table_privilege('anon', 'public.agent_tasks', 'insert')
    or has_table_privilege('anon', 'public.agent_tasks', 'update')
    or has_table_privilege('anon', 'public.agent_tasks', 'delete')
    or has_table_privilege('authenticated', 'public.agent_tasks', 'insert')
    or has_table_privilege('authenticated', 'public.agent_tasks', 'update')
    or has_table_privilege('authenticated', 'public.agent_tasks', 'delete')
    or has_table_privilege('anon', 'public.agent_task_activity', 'insert')
    or has_table_privilege('authenticated', 'public.agent_task_activity', 'insert')
    or has_table_privilege('anon', 'public.approvals', 'insert')
    or has_table_privilege('anon', 'public.approvals', 'update')
    or has_table_privilege('authenticated', 'public.approvals', 'insert')
    or has_table_privilege('authenticated', 'public.approvals', 'update')
    or has_table_privilege('anon', 'public.user_passkeys', 'insert')
    or has_table_privilege('anon', 'public.user_passkeys', 'update')
    or has_table_privilege('anon', 'public.user_passkeys', 'delete')
    or has_table_privilege('authenticated', 'public.user_passkeys', 'insert')
    or has_table_privilege('authenticated', 'public.user_passkeys', 'update')
    or has_table_privilege('authenticated', 'public.user_passkeys', 'delete')
  then
    raise exception 'browser DML grant remains after contract';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.create_agent_task_with_activity(uuid,text,jsonb,uuid,text,jsonb)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.claim_routine_resume(uuid,uuid,uuid,integer)',
    'execute'
  ) then
    raise exception 'service RPC grant missing after contract';
  end if;
end
$$;

reset statement_timeout;
