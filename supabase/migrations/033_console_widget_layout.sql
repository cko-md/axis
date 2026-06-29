-- U3: Freeform dashboard module layout
-- Adds a structured per-user layout blob to console_widgets so the dashboard
-- module cards (sections) can be rearranged in a freeform-but-structured grid
-- and auto-saved on drag-end (debounced), instead of living only in localStorage.
--
-- Shape (all keys optional; reader tolerates a missing column / empty object):
--   {
--     "order": ["widgets", "photos", ...],          -- section render order
--     "sizes": { "pomodoro": "sm", "widgets": "full" } -- per-section grid span
--   }
-- A "sm" block occupies a half-width grid slot, "full" a full-width slot, so
-- the flex/grid packing snaps cards to structured slots with no overlaps.

alter table public.console_widgets
  add column if not exists layout jsonb not null default '{}'::jsonb;

comment on column public.console_widgets.layout is
  'Structured dashboard module layout: { order: text[], sizes: { [sectionId]: "sm"|"full" } }. Auto-saved on drag-end.';
