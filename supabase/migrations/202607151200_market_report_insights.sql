-- Persisted, cited Fund research reports use the existing owner-scoped
-- ai_insights table. This only expands its checked kind taxonomy; its existing
-- user_id RLS policies continue to govern reads and writes.

alter table public.ai_insights drop constraint if exists ai_insights_kind_check;
alter table public.ai_insights add constraint ai_insights_kind_check
  check (kind in ('daily_brief', 'weekly_recap', 'anomaly', 'suggestion', 'subscription_audit', 'market_report'));
