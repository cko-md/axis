-- 038_audit_logs.sql
-- Append-only log of AI, Make, and Composio actions taken on behalf of a
-- user. No update/delete policies on purpose — audit rows are immutable
-- once written (service-role only could amend, which we don't do today).

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  actor text not null check (actor in ('ai', 'make', 'composio', 'user', 'system')),
  action text not null,
  target_table text,
  target_id uuid,
  payload jsonb,
  result text not null default 'success' check (result in ('success', 'failure', 'pending_confirmation')),
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

create policy "audit_logs_select_own"
  on public.audit_logs for select using (auth.uid() = user_id);
create policy "audit_logs_insert_own"
  on public.audit_logs for insert with check (auth.uid() = user_id);

create index if not exists idx_audit_logs_user_created on public.audit_logs (user_id, created_at desc);
