-- fitness_routines.sql
-- Editable strength / conditioning / mobility-yoga routines for the Vitality
-- module (Strength & Conditioning + Yoga & Pilates tabs). Mirrors the RLS /
-- ownership conventions of training_sessions (005_training_sessions.sql).
-- One `fitness_routines` row is a named routine (e.g. "Upper · Push"); its
-- exercises live in `fitness_routine_exercises`, one row per exercise/step,
-- ordered by sort_order. `discipline` distinguishes Strength tab routines
-- from Yoga & Pilates / mobility flows so both tabs can query the same table.

create table if not exists public.fitness_routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'strength' = Strength & Conditioning tab, 'mobility' = Yoga & Pilates tab
  discipline text not null default 'strength'
    check (discipline in ('strength', 'mobility')),
  name text not null default '',
  category text not null default '',  -- e.g. "Upper · Push", "Runner's Mobility"
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fitness_routine_exercises (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.fitness_routines (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  sets integer,                 -- nullable: mobility steps often have no set count
  reps text,                    -- free text: "4 × 8", "15", "3 min"
  weight text,
  rest text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fitness_routines enable row level security;
alter table public.fitness_routine_exercises enable row level security;

create policy "fitness_routines_select_own"
  on public.fitness_routines for select using (auth.uid() = user_id);
create policy "fitness_routines_insert_own"
  on public.fitness_routines for insert with check (auth.uid() = user_id);
create policy "fitness_routines_update_own"
  on public.fitness_routines for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fitness_routines_delete_own"
  on public.fitness_routines for delete using (auth.uid() = user_id);

create policy "fitness_routine_exercises_select_own"
  on public.fitness_routine_exercises for select using (auth.uid() = user_id);
create policy "fitness_routine_exercises_insert_own"
  on public.fitness_routine_exercises for insert with check (auth.uid() = user_id);
create policy "fitness_routine_exercises_update_own"
  on public.fitness_routine_exercises for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fitness_routine_exercises_delete_own"
  on public.fitness_routine_exercises for delete using (auth.uid() = user_id);

create index if not exists idx_fitness_routines_user
  on public.fitness_routines (user_id, discipline, sort_order);
create index if not exists idx_fitness_routine_exercises_routine
  on public.fitness_routine_exercises (routine_id, sort_order);
create index if not exists idx_fitness_routine_exercises_user
  on public.fitness_routine_exercises (user_id);
