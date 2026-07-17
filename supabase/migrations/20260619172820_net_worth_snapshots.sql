-- 018_net_worth_snapshots.sql
-- Daily net-worth time series for the Fund overview chart.
-- One row per user per day (upserted); cash + invested are the user's own
-- displayed totals (cash from Plaid balances, invested from fund_holdings).
-- Mirrors the RLS / ownership conventions of fund_transactions (004).

create table if not exists public.net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  captured_on date not null default current_date,
  cash numeric not null default 0,
  invested numeric not null default 0,
  net_worth numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, captured_on)
);

alter table public.net_worth_snapshots enable row level security;

create policy "net_worth_snapshots_select_own"
  on public.net_worth_snapshots for select using (auth.uid() = user_id);
create policy "net_worth_snapshots_insert_own"
  on public.net_worth_snapshots for insert with check (auth.uid() = user_id);
create policy "net_worth_snapshots_update_own"
  on public.net_worth_snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "net_worth_snapshots_delete_own"
  on public.net_worth_snapshots for delete using (auth.uid() = user_id);

create index if not exists idx_net_worth_snapshots_user
  on public.net_worth_snapshots (user_id, captured_on desc);
