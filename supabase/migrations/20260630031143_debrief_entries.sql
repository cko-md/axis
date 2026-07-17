-- Phase 10 Debrief: daily/weekly review persistence.
-- Stores structured reviews separately from Notes so Debrief can be opened,
-- edited, queried by date, and linked back to tasks/calendar/objectives.

create table if not exists public.debrief_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  review_date date not null,
  review_type text not null default 'daily' check (review_type in ('daily', 'weekly')),
  wins text not null default '',
  challenges text not null default '',
  focus text not null default '',
  summary text not null default '',
  completed_task_ids uuid[] not null default '{}'::uuid[],
  missed_task_ids uuid[] not null default '{}'::uuid[],
  calendar_event_ids uuid[] not null default '{}'::uuid[],
  objective_ids uuid[] not null default '{}'::uuid[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, review_date, review_type)
);

alter table public.debrief_entries enable row level security;

create policy "debrief_entries_select_own"
  on public.debrief_entries for select using (auth.uid() = user_id);
create policy "debrief_entries_insert_own"
  on public.debrief_entries for insert with check (auth.uid() = user_id);
create policy "debrief_entries_update_own"
  on public.debrief_entries for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "debrief_entries_delete_own"
  on public.debrief_entries for delete using (auth.uid() = user_id);

create index if not exists idx_debrief_entries_user_date
  on public.debrief_entries (user_id, review_date desc, review_type);
