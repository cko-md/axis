-- AXIS Phase 1-2 initial schema
-- Run via Supabase SQL editor or: supabase db push

-- Profiles (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role_title text,
  avatar_url text,
  theme text not null default 'dark' check (theme in ('dark', 'dim', 'light', 'slate')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Fund holdings
create table if not exists public.fund_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  name text not null,
  shares numeric not null default 0,
  cost_basis numeric not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol)
);

alter table public.fund_holdings enable row level security;

create policy "fund_holdings_select_own"
  on public.fund_holdings for select using (auth.uid() = user_id);
create policy "fund_holdings_insert_own"
  on public.fund_holdings for insert with check (auth.uid() = user_id);
create policy "fund_holdings_update_own"
  on public.fund_holdings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_holdings_delete_own"
  on public.fund_holdings for delete using (auth.uid() = user_id);

-- Fund watchlist
create table if not exists public.fund_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

alter table public.fund_watchlist enable row level security;

create policy "fund_watchlist_select_own"
  on public.fund_watchlist for select using (auth.uid() = user_id);
create policy "fund_watchlist_insert_own"
  on public.fund_watchlist for insert with check (auth.uid() = user_id);
create policy "fund_watchlist_update_own"
  on public.fund_watchlist for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_watchlist_delete_own"
  on public.fund_watchlist for delete using (auth.uid() = user_id);

-- Fund snapshots (aggregate payload)
create table if not exists public.fund_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  net_worth numeric,
  invested numeric,
  cash numeric,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.fund_snapshots enable row level security;

create policy "fund_snapshots_select_own"
  on public.fund_snapshots for select using (auth.uid() = user_id);
create policy "fund_snapshots_insert_own"
  on public.fund_snapshots for insert with check (auth.uid() = user_id);
create policy "fund_snapshots_update_own"
  on public.fund_snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_snapshots_delete_own"
  on public.fund_snapshots for delete using (auth.uid() = user_id);

-- Console widget layout (one row per user)
create table if not exists public.console_widgets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  widget_ids text[] not null default array['weather','daylight','agenda','air'],
  widget_texts jsonb not null default '{}'::jsonb,
  sort_order text[] not null default array['weather','daylight','agenda','air'],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.console_widgets enable row level security;

create policy "console_widgets_select_own"
  on public.console_widgets for select using (auth.uid() = user_id);
create policy "console_widgets_insert_own"
  on public.console_widgets for insert with check (auth.uid() = user_id);
create policy "console_widgets_update_own"
  on public.console_widgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "console_widgets_delete_own"
  on public.console_widgets for delete using (auth.uid() = user_id);

-- Schedule events
create table if not exists public.schedule_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  color_class text not null default 'a' check (color_class in ('a', 'b', 'c')),
  all_day boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.schedule_events enable row level security;

create policy "schedule_events_select_own"
  on public.schedule_events for select using (auth.uid() = user_id);
create policy "schedule_events_insert_own"
  on public.schedule_events for insert with check (auth.uid() = user_id);
create policy "schedule_events_update_own"
  on public.schedule_events for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "schedule_events_delete_own"
  on public.schedule_events for delete using (auth.uid() = user_id);

-- Granular board fields (axis_v3 field sync)
create table if not exists public.board_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  view_key text not null,
  field_key text not null,
  value text not null default '',
  updated_at timestamptz not null default now(),
  unique (user_id, view_key, field_key)
);

alter table public.board_fields enable row level security;

create policy "board_fields_select_own"
  on public.board_fields for select using (auth.uid() = user_id);
create policy "board_fields_insert_own"
  on public.board_fields for insert with check (auth.uid() = user_id);
create policy "board_fields_update_own"
  on public.board_fields for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "board_fields_delete_own"
  on public.board_fields for delete using (auth.uid() = user_id);

-- Indexes
create index if not exists idx_fund_holdings_user on public.fund_holdings (user_id);
create index if not exists idx_schedule_events_user_start on public.schedule_events (user_id, start_at);
create index if not exists idx_board_fields_user_view on public.board_fields (user_id, view_key);
