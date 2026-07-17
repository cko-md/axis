-- 20260715235237_market_report_insights.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from the live ai_insights_kind_check
-- constraint definition on 2026-07-17.
--
-- Adds 'market_report' as an allowed ai_insights.kind, alongside the
-- existing daily_brief/weekly_recap/anomaly/suggestion/subscription_audit
-- kinds (migration 039_ai_advisor_tables.sql / 041).

alter table public.ai_insights
  drop constraint if exists ai_insights_kind_check;

alter table public.ai_insights
  add constraint ai_insights_kind_check
  check (kind in ('daily_brief', 'weekly_recap', 'anomaly', 'suggestion', 'subscription_audit', 'market_report'));
