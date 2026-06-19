-- 020_drop_fund_snapshots.sql
-- Remove the legacy fund_snapshots table. It was an append-only log (no
-- daily-unique constraint) and is superseded by net_worth_snapshots (018),
-- which the Fund net-worth chart uses. No application code references it
-- (only its original CREATE in 001_initial.sql) and it holds zero rows.

drop table if exists public.fund_snapshots;
