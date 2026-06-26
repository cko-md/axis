-- Shared, keyed-by-URL cache for RSS items fetched by the feed-digest cron
-- (src/app/api/cron/feed-digest/route.ts). Keyed by feed_url rather than
-- user_id since multiple users may subscribe to the same public feed —
-- re-fetching identical public content per-user would be wasted work.
create table if not exists public.feed_cache (
  feed_url text primary key,
  items jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);

alter table public.feed_cache enable row level security;

-- Content here is public RSS data, not user-owned — any signed-in user may
-- read it. Only the service-role cron writes (which bypasses RLS entirely),
-- so no insert/update/delete policy is defined for regular sessions.
create policy "feed_cache_select_authenticated" on public.feed_cache
  for select using (auth.uid() is not null);
