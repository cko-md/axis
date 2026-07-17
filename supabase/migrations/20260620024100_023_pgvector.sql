create extension if not exists vector;

create table if not exists public.note_embeddings (
  id         uuid primary key default gen_random_uuid(),
  note_id    uuid not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  embedding  vector(768),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.note_embeddings enable row level security;

create policy "owner only" on public.note_embeddings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_note_embeddings_user
  on public.note_embeddings (user_id);

create index if not exists idx_note_embeddings_hnsw
  on public.note_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
