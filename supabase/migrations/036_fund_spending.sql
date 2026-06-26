-- 036_fund_spending.sql
-- Persisted Plaid spending transactions (previously fetched live, never
-- stored) and user-set category budget targets, replacing the ephemeral
-- computed-only insights in FundBudget.tsx.

create table if not exists public.fund_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid references public.fund_connections (id) on delete set null,
  plaid_transaction_id text not null,
  account_id text,
  merchant_name text,
  raw_name text,
  amount numeric not null default 0,
  iso_currency_code text not null default 'USD',
  plaid_category text,
  custom_category text,
  tags text[] not null default '{}',
  is_transfer boolean not null default false,
  excluded_from_budget boolean not null default false,
  reviewed boolean not null default false,
  pending boolean not null default false,
  posted_date date not null,
  authorized_date date,
  split_parent_id uuid references public.fund_bank_transactions (id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, plaid_transaction_id)
);

alter table public.fund_bank_transactions enable row level security;

create policy "fund_bank_transactions_select_own"
  on public.fund_bank_transactions for select using (auth.uid() = user_id);
create policy "fund_bank_transactions_insert_own"
  on public.fund_bank_transactions for insert with check (auth.uid() = user_id);
create policy "fund_bank_transactions_update_own"
  on public.fund_bank_transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_bank_transactions_delete_own"
  on public.fund_bank_transactions for delete using (auth.uid() = user_id);

create index if not exists idx_fund_bank_transactions_user_date
  on public.fund_bank_transactions (user_id, posted_date desc);

create table if not exists public.fund_category_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  monthly_limit numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category)
);

alter table public.fund_category_budgets enable row level security;

create policy "fund_category_budgets_select_own"
  on public.fund_category_budgets for select using (auth.uid() = user_id);
create policy "fund_category_budgets_insert_own"
  on public.fund_category_budgets for insert with check (auth.uid() = user_id);
create policy "fund_category_budgets_update_own"
  on public.fund_category_budgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_category_budgets_delete_own"
  on public.fund_category_budgets for delete using (auth.uid() = user_id);

-- fund_holdings: source-aware aggregation (decision: never merge holdings
-- across providers — aggregate at query time instead).
alter table public.fund_holdings
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'plaid', 'public')),
  add column if not exists connection_id uuid references public.fund_connections (id) on delete set null;

alter table public.net_worth_snapshots
  add column if not exists liabilities numeric not null default 0;
