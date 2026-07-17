-- Adds a real date the deadline-watch cron step can act on. `date_label` stays
-- untouched for display (often free text like "Oct 12–16") — this is additive.
alter table public.conferences
  add column if not exists abstract_due_date date;
