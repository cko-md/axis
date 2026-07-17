\set ON_ERROR_STOP on

-- Local-only deterministic two-session proof for sync_vector_save(). The
-- connection default targets the documented Supabase development database.
-- Override with: psql -v vector_dblink_conn='...' -f this-file.sql
\if :{?vector_dblink_conn}
\else
  \set vector_dblink_conn 'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
\endif

select exists (
  select 1 from pg_extension where extname = 'dblink'
) as vector_dblink_preexisting
\gset

create extension if not exists dblink with schema extensions;

\set vector_test_user 'c1520000-0000-4152-8152-000000000001'
\set vector_writer_a_key 'c1520000-0000-4152-8152-00000000000a'
\set vector_writer_b_key 'c1520000-0000-4152-8152-00000000000b'
\set vector_test_slot 'wave-152-race'

select extensions.dblink_disconnect(connection_name)
from unnest(coalesce(extensions.dblink_get_connections(), array[]::text[])) as connection_name
where connection_name in ('vector_writer_a', 'vector_writer_b');

delete from auth.users where id = :'vector_test_user'::uuid;
insert into auth.users (
  id, aud, role, email, created_at, updated_at
) values (
  :'vector_test_user'::uuid,
  'authenticated',
  'authenticated',
  'vector-wave-152-concurrency@local.test',
  statement_timestamp(),
  statement_timestamp()
);

create temporary table vector_concurrency_results (
  writer text primary key,
  result jsonb not null
);

select extensions.dblink_connect(
  'vector_writer_a',
  :'vector_dblink_conn'
);
select extensions.dblink_connect(
  'vector_writer_b',
  :'vector_dblink_conn'
);

-- Hold the exact user/game advisory key used by sync_vector_save() on writer A.
-- Writer B can enter the RPC but cannot inspect or mutate the slot until A has
-- committed its expected-revision=0 write.
select *
from extensions.dblink(
  'vector_writer_a',
  format(
    'select pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(%L, 0))',
    :'vector_test_user' || ':second-sense'
  )
) as acquired_lock(ignored text);

select extensions.dblink_send_query(
  'vector_writer_b',
  format(
    $query$
      select public.sync_vector_save(
        %L::uuid,
        'second-sense',
        'device-race-writer-b',
        %L::uuid,
        %L,
        %L,
        '1.0.0',
        1,
        0,
        1,
        %L,
        null,
        '{"winner":"b"}'::jsonb,
        statement_timestamp()
      )
    $query$,
    :'vector_test_user',
    :'vector_writer_b_key',
    repeat('b', 64),
    :'vector_test_slot',
    repeat('2', 64)
  )
);

insert into vector_concurrency_results (writer, result)
select 'a', result
from extensions.dblink(
  'vector_writer_a',
  format(
    $query$
      select public.sync_vector_save(
        %L::uuid,
        'second-sense',
        'device-race-writer-a',
        %L::uuid,
        %L,
        %L,
        '1.0.0',
        1,
        0,
        1,
        %L,
        null,
        '{"winner":"a"}'::jsonb,
        statement_timestamp()
      )
    $query$,
    :'vector_test_user',
    :'vector_writer_a_key',
    repeat('a', 64),
    :'vector_test_slot',
    repeat('1', 64)
  )
) as writer_a(result jsonb);

select *
from extensions.dblink(
  'vector_writer_a',
  format(
    'select pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(%L, 0))',
    :'vector_test_user' || ':second-sense'
  )
) as released_lock(unlocked boolean);

insert into vector_concurrency_results (writer, result)
select 'b', result
from extensions.dblink_get_result('vector_writer_b') as writer_b(result jsonb);

do $$
declare
  v_user_id uuid := 'c1520000-0000-4152-8152-000000000001';
  v_applied integer;
  v_conflicts integer;
begin
  select
    count(*) filter (where result->>'status' = 'applied'),
    count(*) filter (where result->>'status' = 'conflict')
  into v_applied, v_conflicts
  from vector_concurrency_results;

  if v_applied <> 1 or v_conflicts <> 1 then
    raise exception 'expected one applied and one conflict, got %',
      (select jsonb_object_agg(writer, result) from vector_concurrency_results);
  end if;
  if (select state from public.game_saves
      where user_id = v_user_id
        and game_id = 'second-sense'
        and slot_id = 'wave-152-race') <> '{"winner":"a"}'::jsonb then
    raise exception 'the accepted branch was overwritten';
  end if;
  if (select count(*) from public.game_saves
      where user_id = v_user_id
        and game_id = 'second-sense'
        and slot_id = 'wave-152-race') <> 1 then
    raise exception 'the race produced more than one current save';
  end if;
  if (select count(*) from public.game_save_conflicts
      where user_id = v_user_id
        and game_id = 'second-sense'
        and slot_id = 'wave-152-race'
        and status = 'open'
        and local_state = '{"winner":"b"}'::jsonb
        and server_state = '{"winner":"a"}'::jsonb) <> 1 then
    raise exception 'the losing branch was not preserved exactly once';
  end if;
  if (select count(*) from public.game_events
      where user_id = v_user_id
        and idempotency_key in (
          'c1520000-0000-4152-8152-00000000000a'::uuid,
          'c1520000-0000-4152-8152-00000000000b'::uuid
        )) <> 2 then
    raise exception 'the concurrency ledger is incomplete';
  end if;
end;
$$;

select extensions.dblink_disconnect('vector_writer_a');
select extensions.dblink_disconnect('vector_writer_b');

delete from auth.users where id = :'vector_test_user'::uuid;

do $$
begin
  if exists (
    select 1 from public.game_events
    where user_id = 'c1520000-0000-4152-8152-000000000001'::uuid
  ) then
    raise exception 'VECTOR concurrency cleanup left owner rows behind';
  end if;
end;
$$;

\if :vector_dblink_preexisting
\else
  drop extension dblink;
\endif

\echo 'VECTOR concurrent CAS test passed'
