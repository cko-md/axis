# Migration renumber plan (AR-018)

> Non-destructive documentation only. **Do not apply without human approval and prod validation.**

## Problem

`supabase/migrations/` has duplicate version prefixes (`011_*`, `020_*`, `036_*`), unnumbered `030x_*` files, and policy conflicts (`027_security_definer_lockdown.sql` vs `011_avatars_bucket.sql`). A clean `supabase db reset` from repo migrations fails (audit finding A4).

## Recommended approach (human-gated)

1. **Inventory** applied migrations in production Supabase (`schema_migrations` table).
2. **Squash** into a single baseline migration for new environments OR renumber with non-colliding `YYYYMMDDHHMMSS_` prefixes.
3. **Fix policy conflicts** by `DROP POLICY IF EXISTS` before `CREATE POLICY` in conflicting files.
4. **Validate** on a fresh local stack + staging before prod.
5. **Never** rewrite history on prod without a documented rollback.

## Agent constraint

Autonomous agents must not rename or squash migrations in this repo without an explicit Linear issue approving destructive migration work.
