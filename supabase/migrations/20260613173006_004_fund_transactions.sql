-- 004_fund_transactions.sql
-- Fund transaction ledger: order-ticket captures (buys/sells) and cash-flow entries.
-- DO NOT APPLY blindly — review against the live project before running.
-- Mirrors the RLS / ownership conventions of fund_holdings (001_initial.sql).

create table if not exists public.fund_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal' | 'fee'
  kind text not null default 'buy'
    check (kind in ('buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'fee')),
  symbol text,                       -- null for pure cash entries (deposit/withdrawal)
  name text,
  shares numeric not null default 0,
  price numeric not null default 0,  -- per-share execution price
  amount numeric not null default 0, -- signed cash delta (negative = cash out)
  fee numeric not null default 0,
  source text not null default 'manual'
    check (source in ('manual', 'public', 'plaid', 'import')),
  note text,
  executed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.fund_transactions enable row level security;

create policy "fund_transactions_select_own"
  on public.fund_transactions for select using (auth.uid() = user_id);
create policy "fund_transactions_insert_own"
  on public.fund_transactions for insert with check (auth.uid() = user_id);
create policy "fund_transactions_update_own"
  on public.fund_transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_transactions_delete_own"
  on public.fund_transactions for delete using (auth.uid() = user_id);

create index if not exists idx_fund_transactions_user
  on public.fund_transactions (user_id, executed_at desc);

-- Linked external accounts (Plaid items / brokerage connections).
-- Tokens are NEVER stored client-readable; server routes own them. This table only
-- holds display metadata + the provider item id so the UI can show "connected" state.
create table if not exists public.fund_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('plaid', 'public')),
  item_id text,                      -- Plaid item_id / brokerage account ref
  institution text,
  mask text,                         -- last-4 of linked account
  status text not null default 'linked' check (status in ('linked', 'error', 'revoked')),
  created_at timestamptz not null default now(),
  unique (user_id, provider, item_id)
);

alter table public.fund_connections enable row level security;

create policy "fund_connections_select_own"
  on public.fund_connections for select using (auth.uid() = user_id);
create policy "fund_connections_insert_own"
  on public.fund_connections for insert with check (auth.uid() = user_id);
create policy "fund_connections_update_own"
  on public.fund_connections for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_connections_delete_own"
  on public.fund_connections for delete using (auth.uid() = user_id);

create index if not exists idx_fund_connections_user
  on public.fund_connections (user_id, provider);
