-- FIN-003/FIN-004 expansion privilege repair.
--
-- Supabase project-level default privileges predate the financial authority
-- boundary and grant broad table privileges to `anon`. RLS currently blocks
-- those operations, but financial safety must not depend on that redundant
-- grant surface. The exact net-worth projection already declares
-- security-invoker semantics; this repair reasserts that boundary, adds a
-- security barrier, and removes inherited write-capable grants before restoring
-- the intended select-only roles.

begin;

revoke all on table
  public.fund_bank_transactions,
  public.fund_category_budgets,
  public.fund_connections,
  public.fund_execution_receipts,
  public.fund_holdings,
  public.fund_liabilities,
  public.fund_order_intents,
  public.fund_order_submissions,
  public.fund_provider_coverage,
  public.fund_recurring_transactions,
  public.fund_transactions,
  public.fund_watchlist,
  public.integration_delivery_outbox,
  public.net_worth_snapshots,
  public.net_worth_snapshot_revisions
from public, anon;

alter view public.net_worth_snapshots_exact
  set (security_invoker = true, security_barrier = true);
revoke all on table public.net_worth_snapshots_exact
  from public, anon, authenticated, service_role;
grant select on table public.net_worth_snapshots_exact
  to authenticated, service_role;

commit;
