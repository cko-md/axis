alter table public.tasks add column if not exists completed_at timestamptz;

update public.tasks
set completed_at = updated_at
where status = 'done' and completed_at is null;

create index if not exists idx_tasks_user_completed
  on public.tasks (user_id, completed_at);
