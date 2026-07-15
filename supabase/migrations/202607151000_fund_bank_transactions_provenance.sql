-- 202607151000_fund_bank_transactions_provenance.sql
-- Wave 4.6 of docs/axis-redesign. Companion to
-- 202607131700_fund_provenance_columns.sql, which added provenance/freshness
-- columns to the other financial value tables (fund_holdings,
-- fund_liabilities, fund_transactions) but not to fund_bank_transactions.
--
-- fund_bank_transactions holds the Plaid-synced spending ledger surfaced by the
-- Activity (spending) view. To make its freshness badge meaningful we need to
-- know *when* each row was retrieved from Plaid. The column is additive
-- (nullable), so this is backward compatible with existing rows and read paths.
--
-- retrieved_at is stamped by src/lib/fund/syncPlaidTransactions.ts at sync time
-- (the freshness anchor for a just-pulled transaction).
--
-- Note: no `currency` column is added — the table's existing
-- `iso_currency_code` column already serves the Provenance.currency role
-- (same precedent as fund_transactions reusing `source` for provider in
-- 202607131700_fund_provenance_columns.sql); the sync path now populates it
-- from the Plaid row instead of leaving the 'USD' default.

alter table public.fund_bank_transactions
  add column if not exists retrieved_at timestamptz;

-- Review checklist before applying:
--   1. Confirm target Supabase project (`supabase link` / project ref).
--   2. Run `supabase db diff` against a shadow DB to confirm no destructive ops.
--   3. Confirm RLS is unaffected (this migration adds columns only; no new
--      tables, so no new policies are required).
--   4. retrieved_at stays NULL for pre-existing rows (freshness unknown until
--      the next sync stamps them), which the UI renders as "no badge".
--   5. Apply via the project's standard Supabase migration flow, then verify
--      with `select column_name from information_schema.columns where
--      table_name = 'fund_bank_transactions'`.
