-- 027 revoked EXECUTE from anon/authenticated directly, but new/replaced
-- functions in Postgres get an implicit GRANT EXECUTE TO PUBLIC, and anon/
-- authenticated inherit through that — so the prior revoke had no effect
-- (confirmed via has_function_privilege('anon', ..., 'EXECUTE') = true).
-- PUBLIC must be revoked explicitly; then grant back only what's intended.

revoke execute on function public.search_note_embeddings(vector, integer) from public;
grant execute on function public.search_note_embeddings(vector, integer) to authenticated;

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.cleanup_expired_challenges() from public;
revoke execute on function public.cleanup_old_signals() from public;
revoke execute on function public.mark_overdue_tasks() from public;
revoke execute on function public.purge_old_done_tasks() from public;
