-- 20260717000000_restore_routine_version_check.sql
-- Restore the CHECK (routine_version > 0) constraint that prod's routine_versions
-- table already carries (as routine_versions_routine_version_check) but which main's
-- backfilled 20260715224156_routine_versions.sql omitted. Without this, a fresh
-- replay of main's migrations builds a table that diverges from prod.
--
-- Idempotent and prod-name-consistent: a no-op against prod (the constraint already
-- exists there under this exact name); only takes effect on a from-scratch rebuild.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.routine_versions'::regclass
      and conname = 'routine_versions_routine_version_check'
  ) then
    alter table public.routine_versions
      add constraint routine_versions_routine_version_check check (routine_version > 0);
  end if;
end $$;
