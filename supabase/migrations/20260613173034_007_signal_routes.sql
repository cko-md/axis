-- Signal routes: user-definable routing rules + destinations for the Signals inbox.
-- A route maps a matcher (keyword / signal_type / source) to a destination module,
-- optionally overriding priority and auto-routing matching signals.
-- NOT YET APPLIED — review before running against the production project.

create table if not exists public.signal_routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  -- destination module the signal is routed into
  destination text not null default 'agenda'
    check (destination in ('agenda', 'schedule', 'notes', 'pipeline', 'fund', 'literature', 'library', 'people')),
  -- match by free-text keyword (case-insensitive, matches title/body), signal type, and/or source
  match_keyword text,
  match_type text check (match_type is null or match_type in ('action', 'awaiting', 'fyi')),
  match_source text,
  -- priority to stamp on the routed item ('keep' = leave as-is)
  set_priority text not null default 'keep'
    check (set_priority in ('keep', 'hi', 'med', 'lo')),
  -- when true, matching signals are auto-routed on arrival / batch triage
  auto_route boolean not null default false,
  enabled boolean not null default true,
  sort_order int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.signal_routes enable row level security;
create policy "signal_routes_select_own" on public.signal_routes for select using (auth.uid() = user_id);
create policy "signal_routes_insert_own" on public.signal_routes for insert with check (auth.uid() = user_id);
create policy "signal_routes_update_own" on public.signal_routes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "signal_routes_delete_own" on public.signal_routes for delete using (auth.uid() = user_id);
create index if not exists idx_signal_routes_user on public.signal_routes (user_id, enabled, sort_order);

-- Track AI-derived classification + suggested destination on signals without a schema migration churn:
-- these live in signals.metadata (jsonb) as { ai_suggested_destination, ai_reason, ai_confidence, routed_via }.
-- No column changes required; documented here for clarity.
