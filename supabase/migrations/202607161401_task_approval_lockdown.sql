-- Atomic task / approval lifecycle mutations (contract phase).
--
-- This sorts after the task, WebAuthn, and routine-resume expansion migrations.
-- Apply only after the application version that uses their service-role RPCs is
-- live. Separating this from the additive migrations avoids breaking the
-- currently deployed direct-write routes during rollout.

begin;

drop policy if exists "agent_tasks_insert_own" on public.agent_tasks;
drop policy if exists "agent_tasks_update_own" on public.agent_tasks;
drop policy if exists "agent_tasks_delete_own" on public.agent_tasks;
drop policy if exists "agent_task_activity_insert_own" on public.agent_task_activity;
drop policy if exists "approvals_insert_own" on public.approvals;
drop policy if exists "approvals_update_own" on public.approvals;

revoke insert, update, delete on public.agent_tasks from anon, authenticated;
revoke insert on public.agent_task_activity from anon, authenticated;
revoke insert, update on public.approvals from anon, authenticated;
revoke insert, update, delete on public.user_passkeys from anon, authenticated;

commit;
