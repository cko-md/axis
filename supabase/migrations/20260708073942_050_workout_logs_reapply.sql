-- 20260708073942_050_workout_logs_reapply.sql
-- BACKFILL: the live project's migration history (list_migrations) shows
-- "050_workout_logs" applied twice, at 20260708072708 (already tracked as
-- 050_workout_logs.sql in this repo) and again here at 20260708073942, six
-- minutes later. The workout_logs table matches the first migration's
-- definition with no evidence of a schema difference between the two
-- applies — this is recorded as an idempotent re-run, not a distinct change.
-- No-op: table/policies/indexes already created by 050_workout_logs.sql.

select 1;
