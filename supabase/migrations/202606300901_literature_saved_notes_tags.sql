-- Phase 9 Literature: saved-paper annotations.
-- Non-destructive extension of the optional literature_saved table.

alter table if exists public.literature_saved
  add column if not exists notes text not null default '',
  add column if not exists tags text[] not null default '{}'::text[];

do $$
begin
  if to_regclass('public.literature_saved') is not null then
    create index if not exists idx_literature_saved_tags
      on public.literature_saved using gin (tags);
  end if;
end $$;
