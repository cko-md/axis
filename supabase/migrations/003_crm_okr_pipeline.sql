-- People (CRM), objectives + key results + habits, study pipeline + conferences

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  role text not null default '',
  note text not null default '',
  tag text not null default 'collaborator' check (tag in ('mentor', 'collaborator', 'friend')),
  last_contact_on date,
  follow_up_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.people enable row level security;
create policy "people_select_own" on public.people for select using (auth.uid() = user_id);
create policy "people_insert_own" on public.people for insert with check (auth.uid() = user_id);
create policy "people_update_own" on public.people for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "people_delete_own" on public.people for delete using (auth.uid() = user_id);
create index if not exists idx_people_user_tag on public.people (user_id, tag, follow_up_on);

create table if not exists public.objectives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  descriptor text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.objectives enable row level security;
create policy "objectives_select_own" on public.objectives for select using (auth.uid() = user_id);
create policy "objectives_insert_own" on public.objectives for insert with check (auth.uid() = user_id);
create policy "objectives_update_own" on public.objectives for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "objectives_delete_own" on public.objectives for delete using (auth.uid() = user_id);
create index if not exists idx_objectives_user on public.objectives (user_id, sort_order);

create table if not exists public.key_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  objective_id uuid not null references public.objectives (id) on delete cascade,
  title text not null,
  current_value numeric not null default 0,
  target_value numeric not null default 1 check (target_value > 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.key_results enable row level security;
create policy "key_results_select_own" on public.key_results for select using (auth.uid() = user_id);
create policy "key_results_insert_own" on public.key_results for insert with check (auth.uid() = user_id);
create policy "key_results_update_own" on public.key_results for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "key_results_delete_own" on public.key_results for delete using (auth.uid() = user_id);
create index if not exists idx_key_results_objective on public.key_results (objective_id, sort_order);

create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  icon text not null default '✦',
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.habits enable row level security;
create policy "habits_select_own" on public.habits for select using (auth.uid() = user_id);
create policy "habits_insert_own" on public.habits for insert with check (auth.uid() = user_id);
create policy "habits_update_own" on public.habits for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "habits_delete_own" on public.habits for delete using (auth.uid() = user_id);
create index if not exists idx_habits_user on public.habits (user_id, sort_order);

create table if not exists public.habit_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  habit_id uuid not null references public.habits (id) on delete cascade,
  checked_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (habit_id, checked_on)
);

alter table public.habit_checks enable row level security;
create policy "habit_checks_select_own" on public.habit_checks for select using (auth.uid() = user_id);
create policy "habit_checks_insert_own" on public.habit_checks for insert with check (auth.uid() = user_id);
create policy "habit_checks_delete_own" on public.habit_checks for delete using (auth.uid() = user_id);
create index if not exists idx_habit_checks_habit on public.habit_checks (habit_id, checked_on desc);

create table if not exists public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  swatch text not null default 'var(--accent)',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.pipeline_stages enable row level security;
create policy "pipeline_stages_select_own" on public.pipeline_stages for select using (auth.uid() = user_id);
create policy "pipeline_stages_insert_own" on public.pipeline_stages for insert with check (auth.uid() = user_id);
create policy "pipeline_stages_update_own" on public.pipeline_stages for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "pipeline_stages_delete_own" on public.pipeline_stages for delete using (auth.uid() = user_id);
create index if not exists idx_pipeline_stages_user on public.pipeline_stages (user_id, sort_order);

create table if not exists public.studies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stage_id uuid not null references public.pipeline_stages (id) on delete cascade,
  title text not null,
  role text not null default 'First Author' check (role in ('First Author', 'Co-author')),
  meta text not null default '',
  next_action text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studies enable row level security;
create policy "studies_select_own" on public.studies for select using (auth.uid() = user_id);
create policy "studies_insert_own" on public.studies for insert with check (auth.uid() = user_id);
create policy "studies_update_own" on public.studies for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "studies_delete_own" on public.studies for delete using (auth.uid() = user_id);
create index if not exists idx_studies_stage on public.studies (stage_id, sort_order);

create table if not exists public.conferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  location text not null default '',
  date_label text not null default '',
  status text not null default 'planned' check (status in ('accepted', 'abstract_due', 'invited', 'planned')),
  abstract text not null default '',
  travel text not null default '',
  next_step text not null default '',
  linked_study_id uuid references public.studies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conferences enable row level security;
create policy "conferences_select_own" on public.conferences for select using (auth.uid() = user_id);
create policy "conferences_insert_own" on public.conferences for insert with check (auth.uid() = user_id);
create policy "conferences_update_own" on public.conferences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "conferences_delete_own" on public.conferences for delete using (auth.uid() = user_id);
create index if not exists idx_conferences_user on public.conferences (user_id, created_at desc);
