-- Vitality persistence: meditation session logs (previously localStorage-only)
-- and meal logs (previously not persisted at all — lost on every reload).

create table if not exists public.meditation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  type text not null,
  duration_min integer not null,
  mood_before smallint not null,
  mood_after smallint not null,
  notes text not null default ''
);

alter table public.meditation_sessions enable row level security;
create policy "meditation_sessions_select_own" on public.meditation_sessions for select using (auth.uid() = user_id);
create policy "meditation_sessions_insert_own" on public.meditation_sessions for insert with check (auth.uid() = user_id);
create policy "meditation_sessions_update_own" on public.meditation_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "meditation_sessions_delete_own" on public.meditation_sessions for delete using (auth.uid() = user_id);
create index if not exists idx_meditation_sessions_user on public.meditation_sessions (user_id, occurred_at desc);

create table if not exists public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  logged_at timestamptz not null default now(),
  emoji text not null default '🍽️',
  title text not null,
  timing text not null default '',
  macros text not null default ''
);

alter table public.meal_logs enable row level security;
create policy "meal_logs_select_own" on public.meal_logs for select using (auth.uid() = user_id);
create policy "meal_logs_insert_own" on public.meal_logs for insert with check (auth.uid() = user_id);
create policy "meal_logs_update_own" on public.meal_logs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "meal_logs_delete_own" on public.meal_logs for delete using (auth.uid() = user_id);
create index if not exists idx_meal_logs_user on public.meal_logs (user_id, logged_at desc);
