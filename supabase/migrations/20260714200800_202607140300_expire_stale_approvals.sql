-- 20260714200800_202607140300_expire_stale_approvals.sql
-- BACKFILL: this migration originally created public.expire_stale_approvals()
-- (a SECURITY DEFINER maintenance function that flips overdue-pending
-- approvals to 'expired' and logs the transition to agent_task_activity).
-- Its .sql was never committed, and the function was replaced in place by
-- the later migration 20260716002837_lock_expire_stale_approvals.sql, so the
-- original function body from this version could not be recovered — only the
-- current, superseded-and-hardened body is introspectable.
--
-- No-op here to avoid guessing at (and possibly misrepresenting) a security-
-- relevant function body. See 20260716002837_lock_expire_stale_approvals.sql
-- for the actual function definition, which supersedes whatever this
-- migration originally created.

select 1;
