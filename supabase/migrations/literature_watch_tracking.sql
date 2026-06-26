-- Tracks which article ids the paper-watch cron (src/lib/literature/watch.ts)
-- has already surfaced as a signal, so the same new paper isn't re-alerted on
-- every daily sweep. Capped at the last ~50 ids per user by the app layer.
alter table public.literature_prefs
  add column if not exists last_seen_ids text[] not null default '{}'::text[];
