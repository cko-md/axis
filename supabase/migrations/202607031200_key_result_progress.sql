-- OBJ-2: append-only progress log for key results. Every time a key result's
-- current_value changes, a row records the before/after, the delta, and a
-- human-readable source ("Manual +1", "AI scan", etc.) so the objective detail
-- can show how progress accrued over time and where it came from — instead of
-- only the latest number with no history or explanation.

create table if not exists public.key_result_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key_result_id uuid not null references public.key_results (id) on delete cascade,
  previous_value numeric not null,
  new_value numeric not null,
  delta numeric not null,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

alter table public.key_result_progress enable row level security;

create policy "key_result_progress_select_own"
  on public.key_result_progress for select using (auth.uid() = user_id);
create policy "key_result_progress_insert_own"
  on public.key_result_progress for insert with check (auth.uid() = user_id);

-- History is read newest-first per key result.
create index if not exists idx_key_result_progress_kr
  on public.key_result_progress (key_result_id, created_at desc);

create index if not exists idx_key_result_progress_user
  on public.key_result_progress (user_id, created_at desc);

comment on table public.key_result_progress is
  'Append-only per-user log of key-result value changes (OBJ-2 progress history + source explanation).';
