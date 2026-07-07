-- Avatars storage bucket + owner-scoped RLS.
--
-- RECOVERED (2026-07-06) to reconcile migration drift: this bucket and its
-- policies were applied to production as tracked migration version
-- 20260614050112 ("011_avatars_bucket") but had no local migration file, so a
-- from-scratch `supabase db reset` would have rebuilt the schema WITHOUT the
-- avatars bucket. Recovered idempotently from the live definition so the repo
-- is once again a faithful, replayable source of truth. See
-- docs/production-readiness.md §2.
--
-- Public bucket (avatars are referenced by public URL) but writes and the
-- authenticated SELECT are owner-scoped: an object's first path segment must be
-- the owner's auth.uid() (i.e. objects live under `<user_id>/...`).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880, -- 5 MiB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_select_owner on storage.objects;
create policy avatars_select_owner on storage.objects
  for select
  using (bucket_id = 'avatars' and auth.uid() = owner);

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
  for insert
  with check (bucket_id = 'avatars' and (auth.uid())::text = (storage.foldername(name))[1]);

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
  for update
  using (bucket_id = 'avatars' and (auth.uid())::text = (storage.foldername(name))[1]);

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects
  for delete
  using (bucket_id = 'avatars' and (auth.uid())::text = (storage.foldername(name))[1]);
