-- Literature: allow saved-article updates + persist custom topic definitions.
alter table public.literature_prefs
  add column if not exists custom_topics jsonb not null default '[]'::jsonb;

drop policy if exists "literature_saved_update_own" on public.literature_saved;
create policy "literature_saved_update_own"
  on public.literature_saved for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
