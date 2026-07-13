-- 202607131700_fund_provenance_columns.sql
-- Written to back the pure domain layer in
-- src/lib/fund/provenance.ts (wave 4.3 of docs/axis-redesign) — this migration
-- only adds nullable/defaulted columns, so it is additive and backward
-- compatible with existing rows and read paths.
--
-- Adds provenance + freshness + reconciliation columns to the financial value
-- tables, so every financially material row can answer: which provider said
-- this, what was their record id, when was it retrieved, when was it
-- effective, what currency, and (if reconciled against a second source) what
-- state. See docs/axis-redesign/04-target-architecture.md and
-- src/lib/fund/provenance.ts for the corresponding typed/pure logic.
--
-- Reconciliation state mirrors src/lib/fund/provenance.ts ReconciliationState:
-- 'matched' | 'partial' | 'conflicting' | 'missing' | 'stale' | 'pending'.

alter table public.fund_holdings
  add column if not exists provider text,
  add column if not exists provider_record_id text,
  add column if not exists retrieved_at timestamptz,
  add column if not exists effective_at timestamptz,
  add column if not exists currency text not null default 'USD',
  add column if not exists reconciliation_state text
    check (reconciliation_state in ('matched', 'partial', 'conflicting', 'missing', 'stale', 'pending'));

alter table public.fund_liabilities
  add column if not exists provider text,
  add column if not exists provider_record_id text,
  add column if not exists retrieved_at timestamptz,
  add column if not exists effective_at timestamptz,
  add column if not exists currency text not null default 'USD',
  add column if not exists reconciliation_state text
    check (reconciliation_state in ('matched', 'partial', 'conflicting', 'missing', 'stale', 'pending'));

alter table public.fund_transactions
  add column if not exists provider_record_id text,
  add column if not exists retrieved_at timestamptz,
  add column if not exists currency text not null default 'USD',
  add column if not exists reconciliation_state text
    check (reconciliation_state in ('matched', 'partial', 'conflicting', 'missing', 'stale', 'pending'));
-- Note: fund_transactions already has a `source` column (manual/public/plaid/
-- import) that serves the provenance.provider role; not duplicated here.

alter table public.net_worth_snapshots
  add column if not exists computed_at timestamptz not null default now();
-- Note: net_worth_snapshots is a derived rollup (cash/invested/liabilities are
-- sums, not sourced from one provider), so it gets a computed_at freshness
-- marker rather than a single provider/reconciliation_state.

-- Review checklist before applying:
--   1. Confirm target Supabase project (`supabase link` / project ref).
--   2. Run `supabase db diff` against a shadow DB to confirm no destructive ops.
--   3. Confirm RLS is unaffected (this migration adds columns only; no new
--      tables, so no new policies are required).
--   4. Backfill plan for `currency`: defaults to 'USD' for all existing rows —
--      confirm this is correct for any non-USD accounts before relying on it.
--   5. Apply via the project's standard Supabase migration flow, then verify
--      with `select column_name from information_schema.columns where
--      table_name = 'fund_holdings'` (repeat per table).
