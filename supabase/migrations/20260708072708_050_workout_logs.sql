-- Workout regimen logs for Vitality training-week sessions (previously localStorage-only).

create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  log jsonb not null default '{}'::jsonb,
  logged_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, session_id)
);

alter table public.workout_logs enable row level security;

create policy "workout_logs_select_own"
  on public.workout_logs for select using (auth.uid() = user_id);
create policy "workout_logs_insert_own"
  on public.workout_logs for insert with check (auth.uid() = user_id);
create policy "workout_logs_update_own"
  on public.workout_logs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "workout_logs_delete_own"
  on public.workout_logs for delete using (auth.uid() = user_id);

create index if not exists idx_workout_logs_user_session
  on public.workout_logs (user_id, session_id);
