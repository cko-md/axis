create or replace function public.search_note_embeddings(
  p_user_id uuid,
  p_embedding vector(768),
  p_limit int default 10
)
returns table (
  note_id uuid,
  similarity float
)
language sql
security definer
set search_path = public
as $$
  select note_id, 1 - (embedding <=> p_embedding) as similarity
  from public.note_embeddings
  where user_id = p_user_id
  order by embedding <=> p_embedding
  limit p_limit;
$$;

-- NOTE: superseded by 027_security_definer_lockdown.sql — this original signature
-- trusted a client-supplied p_user_id instead of deriving it from auth.uid(),
-- which let any caller read another user's note embeddings via PostgREST RPC.
