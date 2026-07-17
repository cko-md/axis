-- 037_fund_liabilities.sql
-- Liabilities (credit cards, loans — currently untracked entirely) plus
-- additive columns so net worth accounts for debt and holdings can be
-- attributed to a source without ever merging rows across sources.

create table if not exists public.fund_liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid references public.fund_connections (id) on delete set null,
  kind text not null default 'credit_card'
    check (kind in ('credit_card', 'mortgage', 'auto_loan', 'student_loan', 'personal_loan', 'other')),
  name text not null,
  balance numeric not null default 0,
  apr numeric,
  minimum_payment numeric,
  due_date date,
  source text not null default 'manual' check (source in ('manual', 'plaid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fund_liabilities enable row level security;

create policy "fund_liabilities_select_own"
  on public.fund_liabilities for select using (auth.uid() = user_id);
create policy "fund_liabilities_insert_own"
  on public.fund_liabilities for insert with check (auth.uid() = user_id);
create policy "fund_liabilities_update_own"
  on public.fund_liabilities for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_liabilities_delete_own"
  on public.fund_liabilities for delete using (auth.uid() = user_id);

create index if not exists idx_fund_liabilities_user on public.fund_liabilities (user_id);

-- Holdings: tag where a position came from. Multi-source holdings are never
-- merged into one row — the analytics layer sums by symbol across sources.
alter table public.fund_holdings
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'plaid', 'public')),
  add column if not exists connection_id uuid references public.fund_connections (id) on delete set null;

-- Net worth: subtract liabilities so net_worth reflects assets minus debt,
-- not just assets. Existing rows backfill to liabilities = 0 (unchanged net worth).
alter table public.net_worth_snapshots
  add column if not exists liabilities numeric not null default 0;
