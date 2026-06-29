-- Fixes surfaced by Supabase security advisors (get_advisors):
--
-- 1. search_note_embeddings was SECURITY DEFINER and trusted a client-supplied
--    p_user_id instead of deriving identity from the session — any caller with
--    the (public) anon/authenticated API key could pass an arbitrary user_id via
--    PostgREST (POST /rest/v1/rpc/search_note_embeddings) and read another
--    user's note embeddings. Fixed by dropping the parameter and using auth.uid().
-- 2. handle_new_user, cleanup_expired_challenges, cleanup_old_signals,
--    mark_overdue_tasks, purge_old_done_tasks are SECURITY DEFINER maintenance/
--    trigger functions with no business calling them via the public RPC API —
--    revoke EXECUTE from anon/authenticated (trigger invocation and the cron
--    route's service-role client are unaffected by REVOKE).
-- 3. purge_old_done_tasks had a mutable search_path (function_search_path_mutable).
-- 4. avatars_select_public allowed listing all objects in the public avatars
--    bucket via a broad storage.objects SELECT policy; narrowed to owner-only
--    listing (public GET-by-known-path still works — that's bucket-level, not RLS).

drop function if exists public.search_note_embeddings(uuid, vector, integer);

create or replace function public.search_note_embeddings(
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
  where user_id = auth.uid()
  order by embedding <=> p_embedding
  limit p_limit;
$$;

revoke execute on function public.search_note_embeddings(vector, integer) from anon;
grant execute on function public.search_note_embeddings(vector, integer) to authenticated;

create or replace function public.purge_old_done_tasks()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.tasks
  where status = 'done'
    and completed_at < now() - interval '6 months';
$$;

revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.cleanup_expired_challenges() from anon, authenticated;
revoke execute on function public.cleanup_old_signals() from anon, authenticated;
revoke execute on function public.mark_overdue_tasks() from anon, authenticated;
revoke execute on function public.purge_old_done_tasks() from anon, authenticated;

drop policy if exists "avatars_select_public" on storage.objects;
create policy "avatars_select_owner" on storage.objects
  for select using (bucket_id = 'avatars' and auth.uid() = owner);
