-- Literature preferences: per-user selected topics for the curated reading feed,
-- plus optional saved articles. The Literature module degrades to localStorage when
-- this table is absent, so applying this migration is OPTIONAL but recommended for
-- cross-device persistence of a signed-in user's topic selection.
-- NOT YET APPLIED — review before running against the production project.

create table if not exists public.literature_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- topic keys the user follows (match TOPICS keys in /api/literature/route.ts:
  -- neuroscience | dbs | connectomics | neurooncology | methods)
  topics text[] not null default array['neuroscience']::text[],
  -- last free-text query the user ran, if any
  last_query text,
  updated_at timestamptz not null default now()
);

alter table public.literature_prefs enable row level security;
create policy "literature_prefs_select_own" on public.literature_prefs for select using (auth.uid() = user_id);
create policy "literature_prefs_insert_own" on public.literature_prefs for insert with check (auth.uid() = user_id);
create policy "literature_prefs_update_own" on public.literature_prefs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "literature_prefs_delete_own" on public.literature_prefs for delete using (auth.uid() = user_id);

-- Optional: articles the user saved out of the feed. Mirrors the normalized Article shape.
create table if not exists public.literature_saved (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- stable source id, e.g. "pmid:12345", "doi:10.1101/...", "arxiv:2401.00001"
  article_id text not null,
  title text not null,
  authors text,
  source text,
  summary text,
  url text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, article_id)
);

alter table public.literature_saved enable row level security;
create policy "literature_saved_select_own" on public.literature_saved for select using (auth.uid() = user_id);
create policy "literature_saved_insert_own" on public.literature_saved for insert with check (auth.uid() = user_id);
create policy "literature_saved_delete_own" on public.literature_saved for delete using (auth.uid() = user_id);
create index if not exists idx_literature_saved_user on public.literature_saved (user_id, created_at desc);
