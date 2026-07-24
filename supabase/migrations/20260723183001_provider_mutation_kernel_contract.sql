-- Phase 1A contract: apply only after the compatible application revision is
-- recorded live and older instances/in-flight requests are drained. This
-- migration intentionally removes Schedule's legacy browser provider writes.

begin;

revoke all on table public.schedule_events from anon, authenticated;
grant select on table public.schedule_events to service_role;
grant select (
  id, user_id, title, description, start_at, end_at, color_class, all_day,
  recurrence_rule, created_at, updated_at
) on table public.schedule_events to authenticated;
grant insert (
  user_id, title, description, start_at, end_at, color_class, all_day, recurrence_rule, updated_at
) on table public.schedule_events to authenticated;
grant update (
  title, description, start_at, end_at, color_class, all_day, recurrence_rule, updated_at
) on table public.schedule_events to authenticated;

drop policy if exists "schedule_events_delete_own" on public.schedule_events;
drop policy if exists "schedule_events_select_own" on public.schedule_events;
create policy "schedule_events_select_own"
  on public.schedule_events for select to authenticated
  using ((select auth.uid()) = user_id and deleted_at is null);
drop policy if exists "schedule_events_update_own" on public.schedule_events;
create policy "schedule_events_update_own"
  on public.schedule_events for update to authenticated
  using ((select auth.uid()) = user_id and deleted_at is null)
  with check ((select auth.uid()) = user_id and deleted_at is null);

drop trigger if exists schedule_events_tombstone_authority_guard on public.schedule_events;
drop function if exists public.guard_schedule_event_tombstone_authority();

create or replace function public.guard_schedule_event_provider_authority()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('request.jwt.claim.role', true) not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.gcal_event_id is not null or new.outlook_event_id is not null
      or new.deleted_at is not null or new.external_cleanup_state <> 'active'
      or new.calendar_delete_command_id is not null then
      raise exception 'calendar provider authority is server-managed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.gcal_event_id is distinct from old.gcal_event_id
    or new.outlook_event_id is distinct from old.outlook_event_id
    or new.deleted_at is distinct from old.deleted_at
    or new.external_cleanup_state is distinct from old.external_cleanup_state
    or new.calendar_delete_command_id is distinct from old.calendar_delete_command_id then
    raise exception 'calendar provider authority is server-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_events_provider_authority_guard on public.schedule_events;
create trigger schedule_events_provider_authority_guard
  before insert or update on public.schedule_events
  for each row execute function public.guard_schedule_event_provider_authority();
revoke all on function public.guard_schedule_event_provider_authority() from public, anon, authenticated;

-- Fail closed if a partial contract ever leaves the old browser authority.
do $$
begin
  if has_table_privilege('authenticated', 'public.schedule_events', 'DELETE')
    or has_column_privilege('authenticated', 'public.schedule_events', 'gcal_event_id', 'UPDATE')
    or has_column_privilege('authenticated', 'public.schedule_events', 'outlook_event_id', 'UPDATE') then
    raise exception 'schedule event contract did not remove legacy browser authority';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.schedule_events'::regclass
      and tgname = 'schedule_events_provider_authority_guard'
      and not tgisinternal
  ) then
    raise exception 'schedule event provider authority trigger is missing';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'schedule_events'
      and policyname = 'schedule_events_delete_own'
  ) then
    raise exception 'schedule event delete policy remains after contract';
  end if;
end;
$$;

commit;
