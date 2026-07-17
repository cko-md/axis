alter table public.tasks add column if not exists completed_at timestamptz;

create or replace function public.purge_old_done_tasks()
returns void
language sql
security definer
as $$
  delete from public.tasks
  where status = 'done'
    and completed_at < now() - interval '6 months';
$$;
