-- 040_fund_recurring_unique.sql
-- Detected/declared subscriptions & bills. One row per merchant per user —
-- detectRecurring() upserts on this constraint each cron run.

create table if not exists public.fund_recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  merchant_name text not null,
  category text,
  expected_amount numeric not null default 0,
  cadence text not null default 'monthly'
    check (cadence in ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual')),
  next_expected_date date,
  last_seen_date date,
  status text not null default 'active' check (status in ('active', 'cancelled', 'irregular')),
  source text not null default 'detected' check (source in ('detected', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fund_recurring_transactions enable row level security;

create policy "fund_recurring_transactions_select_own"
  on public.fund_recurring_transactions for select using (auth.uid() = user_id);
create policy "fund_recurring_transactions_insert_own"
  on public.fund_recurring_transactions for insert with check (auth.uid() = user_id);
create policy "fund_recurring_transactions_update_own"
  on public.fund_recurring_transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_recurring_transactions_delete_own"
  on public.fund_recurring_transactions for delete using (auth.uid() = user_id);

create index if not exists idx_fund_recurring_transactions_user
  on public.fund_recurring_transactions (user_id, status);

create unique index if not exists fund_recurring_transactions_user_merchant_uniq
  on public.fund_recurring_transactions (user_id, merchant_name);
