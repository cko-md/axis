-- Persist weekly debrief reminder preferences cross-device (replaces localStorage-only path).
alter table public.user_preferences
  add column if not exists debrief_reminder jsonb;
