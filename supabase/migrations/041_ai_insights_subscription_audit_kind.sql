-- 041_ai_insights_subscription_audit_kind.sql
-- Adds the subscription_audit insight kind (Phase 5/7: FIN-504).

alter table public.ai_insights drop constraint ai_insights_kind_check;
alter table public.ai_insights add constraint ai_insights_kind_check
  check (kind in ('daily_brief', 'weekly_recap', 'anomaly', 'suggestion', 'subscription_audit'));
