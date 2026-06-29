create index if not exists idx_conferences_linked_study_id on public.conferences (linked_study_id);
create index if not exists idx_console_photos_user_id on public.console_photos (user_id);
create index if not exists idx_habit_checks_user_id on public.habit_checks (user_id);
create index if not exists idx_key_results_user_id on public.key_results (user_id);
create index if not exists idx_moodboard_images_user_id on public.moodboard_images (user_id);
create index if not exists idx_studies_user_id on public.studies (user_id);
create index if not exists idx_user_passkeys_user_id on public.user_passkeys (user_id);
create index if not exists idx_webauthn_challenges_user_id on public.webauthn_challenges (user_id);

create policy "service_role_only" on public.webauthn_challenges for all using (false);

alter function public.search_note_embeddings(vector, integer) security invoker;
