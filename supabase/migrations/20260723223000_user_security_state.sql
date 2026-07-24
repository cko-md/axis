-- Owner-readable, server-mutated epoch for immediate remembered-MFA revocation.
create table if not exists public.user_security_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mfa_trust_epoch bigint not null default 1 check (mfa_trust_epoch >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_security_state enable row level security;

drop policy if exists "user_security_state_select_own" on public.user_security_state;
create policy "user_security_state_select_own"
  on public.user_security_state
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.axis_create_user_security_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_security_state (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists axis_create_user_security_state on auth.users;
create trigger axis_create_user_security_state
  after insert on auth.users
  for each row execute function public.axis_create_user_security_state();

revoke all on function public.axis_create_user_security_state() from public, anon, authenticated;

-- Install the trigger before the backfill so a concurrent signup cannot land
-- between the snapshot and trigger creation.
insert into public.user_security_state (user_id)
select id from auth.users
on conflict (user_id) do nothing;

create or replace function public.rotate_own_mfa_trust_epoch()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_epoch bigint;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  update public.user_security_state
  set mfa_trust_epoch = mfa_trust_epoch + 1,
      updated_at = pg_catalog.now()
  where user_id = auth.uid()
  returning mfa_trust_epoch into next_epoch;

  if next_epoch is null then
    raise exception 'user security state missing' using errcode = 'P0002';
  end if;
  return next_epoch;
end;
$$;

revoke all on table public.user_security_state from anon, authenticated;
grant select on table public.user_security_state to authenticated;
revoke all on function public.rotate_own_mfa_trust_epoch() from public, anon;
grant execute on function public.rotate_own_mfa_trust_epoch() to authenticated;
