-- Add nighttime routine columns to user_preferences
alter table public.user_preferences
  add column if not exists night_routine jsonb not null default '[]'::jsonb,
  add column if not exists night_routine_checks jsonb not null default '{}'::jsonb;
