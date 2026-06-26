-- 040_fund_recurring_unique.sql
-- Unique constraint so the finance-daily cron's recurring-charge detector
-- can upsert idempotently instead of accumulating duplicate rows per run.
-- Known MVP simplification: a merchant with two genuinely distinct recurring
-- charges at different amounts collapses into one row (last-write-wins).
alter table public.fund_recurring_transactions
  add constraint fund_recurring_transactions_user_merchant_uniq unique (user_id, merchant_name);
