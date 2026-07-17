-- Tasks, signals, notes, preferences, photos

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  priority text not null default 'med' check (priority in ('hi', 'med', 'lo')),
  effort text,
  deadline timestamptz,
  category text not null default 'research' check (category in ('research', 'clinical', 'life', 'personal')),
  status text not null default 'open' check (status in ('open', 'done', 'overdue')),
  sort_order int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
create policy "tasks_select_own" on public.tasks for select using (auth.uid() = user_id);
create policy "tasks_insert_own" on public.tasks for insert with check (auth.uid() = user_id);
create policy "tasks_update_own" on public.tasks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tasks_delete_own" on public.tasks for delete using (auth.uid() = user_id);
create index if not exists idx_tasks_user_category on public.tasks (user_id, category, status);

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text,
  source text not null default 'capture',
  signal_type text not null default 'action' check (signal_type in ('action', 'awaiting', 'fyi')),
  route_target text,
  read_at timestamptz,
  routed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.signals enable row level security;
create policy "signals_select_own" on public.signals for select using (auth.uid() = user_id);
create policy "signals_insert_own" on public.signals for insert with check (auth.uid() = user_id);
create policy "signals_update_own" on public.signals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "signals_delete_own" on public.signals for delete using (auth.uid() = user_id);
create index if not exists idx_signals_user_type on public.signals (user_id, signal_type, created_at desc);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled',
  body text not null default '',
  folder text not null default 'All Notes',
  tags text[] not null default '{}',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notes enable row level security;
create policy "notes_select_own" on public.notes for select using (auth.uid() = user_id);
create policy "notes_insert_own" on public.notes for insert with check (auth.uid() = user_id);
create policy "notes_update_own" on public.notes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "notes_delete_own" on public.notes for delete using (auth.uid() = user_id);
create index if not exists idx_notes_user_folder on public.notes (user_id, folder, updated_at desc);

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nav_order jsonb not null default '{}'::jsonb,
  interface_settings jsonb not null default '{}'::jsonb,
  permissions jsonb not null default '{}'::jsonb,
  morning_routine jsonb not null default '[]'::jsonb,
  routine_checks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;
create policy "user_preferences_select_own" on public.user_preferences for select using (auth.uid() = user_id);
create policy "user_preferences_insert_own" on public.user_preferences for insert with check (auth.uid() = user_id);
create policy "user_preferences_update_own" on public.user_preferences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.console_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  caption text not null default '',
  image_url text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.console_photos enable row level security;
create policy "console_photos_select_own" on public.console_photos for select using (auth.uid() = user_id);
create policy "console_photos_insert_own" on public.console_photos for insert with check (auth.uid() = user_id);
create policy "console_photos_update_own" on public.console_photos for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "console_photos_delete_own" on public.console_photos for delete using (auth.uid() = user_id);
