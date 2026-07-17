-- 20260703112851_key_result_progress_user_index.sql
-- BACKFILL: this migration was applied live (via Supabase MCP apply_migration)
-- but its .sql was never committed, causing repo/prod drift. Reconstructed
-- 2026-07-17 by introspecting the live schema (pg_indexes) — not necessarily
-- byte-identical to the original statement, but produces the same end state.

create index if not exists idx_key_result_progress_user
  on public.key_result_progress (user_id, created_at desc);
