-- 017_recurrence.sql
-- Add recurrence support to schedule_events.
-- recurrence_rule stores a simple string: 'daily' | 'weekly' | null (one-off).
-- Expansion of recurring instances is handled client-side for the displayed week.

alter table public.schedule_events
  add column if not exists recurrence_rule text
    check (recurrence_rule in ('daily', 'weekly'));

comment on column public.schedule_events.recurrence_rule is
  'Optional recurrence: daily | weekly. Null means a one-off event.';
