create table if not exists public.moodboard_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  image_url text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.moodboard_images enable row level security;
create policy "moodboard_images_select_own" on public.moodboard_images for select using (auth.uid() = user_id);
create policy "moodboard_images_insert_own" on public.moodboard_images for insert with check (auth.uid() = user_id);
create policy "moodboard_images_update_own" on public.moodboard_images for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "moodboard_images_delete_own" on public.moodboard_images for delete using (auth.uid() = user_id);
