-- Briefing persistence: saved items (read/watch) and subscribed RSS feeds.
-- Mirrors the BriefingModule.tsx localStorage shapes exactly (SavedItem,
-- savedFeeds) so the one-time client-side import can insert rows as-is.

create table if not exists public.briefing_saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  url text not null,
  type text not null default 'read' check (type in ('read', 'watch')),
  saved_at timestamptz not null default now()
);

alter table public.briefing_saved_items enable row level security;
create policy "briefing_saved_items_select_own" on public.briefing_saved_items for select using (auth.uid() = user_id);
create policy "briefing_saved_items_insert_own" on public.briefing_saved_items for insert with check (auth.uid() = user_id);
create policy "briefing_saved_items_delete_own" on public.briefing_saved_items for delete using (auth.uid() = user_id);
create index if not exists idx_briefing_saved_items_user on public.briefing_saved_items (user_id, saved_at desc);

create table if not exists public.briefing_feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  url text not null,
  created_at timestamptz not null default now(),
  unique (user_id, url)
);

alter table public.briefing_feeds enable row level security;
create policy "briefing_feeds_select_own" on public.briefing_feeds for select using (auth.uid() = user_id);
create policy "briefing_feeds_insert_own" on public.briefing_feeds for insert with check (auth.uid() = user_id);
create policy "briefing_feeds_delete_own" on public.briefing_feeds for delete using (auth.uid() = user_id);
create index if not exists idx_briefing_feeds_user on public.briefing_feeds (user_id, created_at desc);
