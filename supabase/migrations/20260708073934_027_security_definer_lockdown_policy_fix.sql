-- 20260708073934_027_security_definer_lockdown_policy_fix.sql
-- BACKFILL: this migration was applied live but its .sql was never committed
-- (repo/prod drift, discovered 2026-07-17). Unlike the other backfills in this
-- batch, its effect could NOT be reconstructed from the live schema: Postgres
-- only exposes current object state, not a diff against migration 027
-- (027_security_definer_lockdown.sql), and no git history or PR references
-- this migration name to compare against.
--
-- Recorded as a no-op placeholder so the migration history is complete and
-- future `list_migrations` / local-file diffs don't re-flag this version as
-- missing. If the original intent matters (e.g. auditing a security fix),
-- it needs to come from whoever/whatever applied it — check Supabase project
-- activity logs for 2026-07-08, not this repo.

select 1;
