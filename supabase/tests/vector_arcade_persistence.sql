\set ON_ERROR_STOP on

begin;

create temporary table vector_test_users (
  ordinal integer primary key,
  user_id uuid not null
) on commit drop;

insert into vector_test_users (ordinal, user_id)
select row_number() over (order by created_at), id
from auth.users
order by created_at
limit 2;

do $$
declare
  v_user_1 uuid;
  v_user_2 uuid;
  v_device text := 'device-sql-test-1';
  v_result jsonb;
  v_conflict_id uuid;
  v_index integer;
  v_save_key uuid := gen_random_uuid();
  v_resolution_key uuid := gen_random_uuid();
  v_future_key uuid := gen_random_uuid();
  v_event_key uuid := gen_random_uuid();
  v_table text;
  v_function text;
  v_role text;
begin
  select user_id into v_user_1 from vector_test_users where ordinal = 1;
  select user_id into v_user_2 from vector_test_users where ordinal = 2;
  if v_user_1 is null or v_user_2 is null then
    raise exception 'VECTOR SQL tests require two local auth users';
  end if;

  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', v_device, v_save_key, repeat('a', 64),
    'main', '1.0.0', 1, 0, 1, repeat('1', 64), null,
    '{"round":1}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'applied' or (v_result->>'serverRevision')::bigint <> 1 then
    raise exception 'initial save failed: %', v_result;
  end if;

  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', v_device, v_save_key, repeat('a', 64),
    'main', '1.0.0', 1, 0, 1, repeat('1', 64), null,
    '{"round":1}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'duplicate' then
    raise exception 'idempotent retry was not duplicate: %', v_result;
  end if;

  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', v_device, v_save_key, repeat('b', 64),
    'main', '1.0.0', 1, 0, 1, repeat('1', 64), null,
    '{"round":1}'::jsonb, statement_timestamp()
  );
  if v_result->>'code' <> 'VECTOR_IDEMPOTENCY_REUSED' then
    raise exception 'idempotency payload reuse was accepted: %', v_result;
  end if;

  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', 'device-sql-test-2', gen_random_uuid(), repeat('c', 64),
    'main', '1.0.0', 1, 0, 1, repeat('2', 64), null,
    '{"round":2}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'conflict' then
    raise exception 'CAS mismatch did not preserve a conflict: %', v_result;
  end if;
  v_conflict_id := (v_result->>'conflictId')::uuid;
  if (select state from public.game_saves where user_id = v_user_1 and slot_id = 'main')
     <> '{"round":1}'::jsonb then
    raise exception 'CAS mismatch overwrote the accepted branch';
  end if;

  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', 'device-sql-test-3', gen_random_uuid(), repeat('3', 64),
    'main', '1.0.0', 1, 1, 3, repeat('3', 64), null,
    '{"round":3}'::jsonb, statement_timestamp()
  );
  if v_result->>'code' <> 'VECTOR_SAVE_CONFLICT_OPEN'
     or (v_result->>'conflictId')::uuid <> v_conflict_id
     or (select state from public.game_saves
         where user_id = v_user_1 and game_id = 'second-sense' and slot_id = 'main')
        <> '{"round":1}'::jsonb then
    raise exception 'open conflict allowed another device to advance the slot: %', v_result;
  end if;

  update public.game_saves
  set checksum = repeat('9', 64), state = '{"round":9}'::jsonb
  where user_id = v_user_1 and game_id = 'second-sense' and slot_id = 'main';
  v_result := public.resolve_vector_conflict(
    v_user_1, v_conflict_id, gen_random_uuid(), repeat('9', 64),
    1, 'accept-server', null
  );
  if v_result->>'code' <> 'VECTOR_CONFLICT_STALE'
     or (select status from public.game_save_conflicts where id = v_conflict_id) <> 'open' then
    raise exception 'accept-server accepted a branch changed after preview: %', v_result;
  end if;
  update public.game_saves
  set checksum = repeat('1', 64), state = '{"round":1}'::jsonb
  where user_id = v_user_1 and game_id = 'second-sense' and slot_id = 'main';

  v_result := public.resolve_vector_conflict(
    v_user_1, v_conflict_id, v_resolution_key, repeat('d', 64),
    1, 'accept-server', null
  );
  if v_result->>'status' <> 'applied'
     or (select status from public.game_save_conflicts where id = v_conflict_id) <> 'resolved' then
    raise exception 'conflict resolution failed: %', v_result;
  end if;
  v_result := public.resolve_vector_conflict(
    v_user_1, v_conflict_id, v_resolution_key, repeat('d', 64),
    1, 'accept-server', null
  );
  if v_result->>'status' <> 'duplicate' or v_result->>'code' is not null then
    raise exception 'resolved conflict idempotent retry failed: %', v_result;
  end if;

  for v_index in 2..8 loop
    v_result := public.sync_vector_save(
      v_user_1, 'second-sense', v_device, gen_random_uuid(),
      encode(digest('slot-' || v_index::text, 'sha256'), 'hex'),
      'slot-' || v_index::text, '1.0.0', 1, 0, 1,
      repeat(to_hex(v_index), 64), null,
      jsonb_build_object('slot', v_index), statement_timestamp()
    );
    if v_result->>'status' <> 'applied' then
      raise exception 'slot % failed: %', v_index, v_result;
    end if;
  end loop;
  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('e', 64),
    'slot-9', '1.0.0', 1, 0, 1, repeat('9', 64), null,
    '{"slot":9}'::jsonb, statement_timestamp()
  );
  if v_result->>'code' <> 'VECTOR_SAVE_SLOT_LIMIT'
     or (select count(*) from public.game_saves
         where user_id = v_user_1 and game_id = 'second-sense' and deleted_at is null) <> 8 then
    raise exception 'save slot limit failed: %', v_result;
  end if;
  v_result := public.sync_vector_save(
    v_user_1, 'second-sense', 'device-sql-test-2', gen_random_uuid(), repeat('f', 64),
    'main', '1.0.0', 1, 0, 2, repeat('8', 64), null,
    '{"round":"fork-source"}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'conflict' then
    raise exception 'fork source conflict was not preserved: %', v_result;
  end if;
  v_conflict_id := (v_result->>'conflictId')::uuid;
  v_result := public.resolve_vector_conflict(
    v_user_1, v_conflict_id, v_resolution_key, repeat('e', 64),
    1, 'accept-server', null
  );
  if v_result->>'code' <> 'VECTOR_IDEMPOTENCY_REUSED'
     or (select status from public.game_save_conflicts where id = v_conflict_id) <> 'open' then
    raise exception 'resolution idempotency key crossed conflict identity: %', v_result;
  end if;
  v_result := public.resolve_vector_conflict(
    v_user_1, v_conflict_id, gen_random_uuid(), repeat('0', 64),
    1, 'fork-local', 'fork-over-limit'
  );
  if v_result->>'code' <> 'VECTOR_SAVE_SLOT_LIMIT'
     or (select status from public.game_save_conflicts where id = v_conflict_id) <> 'open' then
    raise exception 'fork-local bypassed the slot limit: %', v_result;
  end if;

  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('1', 64),
    1, 'score', '{"mode":"solo","challengeId":null,"value":100}'::jsonb,
    statement_timestamp()
  );
  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('2', 64),
    2, 'score', '{"mode":"solo","challengeId":null,"value":50}'::jsonb,
    statement_timestamp()
  );
  if (select score from public.game_scores
      where user_id = v_user_1 and game_id = 'second-sense' and mode = 'solo') <> 100 then
    raise exception 'best-score max merge failed';
  end if;

  v_result := public.apply_vector_event(
    v_user_1, 'second-sense', v_device, v_event_key, repeat('d', 64),
    3, 'score', '{"mode":"dedup","challengeId":null,"value":120}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'status' <> 'applied' then
    raise exception 'initial idempotent event failed: %', v_result;
  end if;
  v_result := public.apply_vector_event(
    v_user_1, 'second-sense', v_device, v_event_key, repeat('d', 64),
    3, 'score', '{"mode":"dedup","challengeId":null,"value":120}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'status' <> 'duplicate'
     or (select count(*) from public.game_events
         where user_id = v_user_1 and idempotency_key = v_event_key) <> 1 then
    raise exception 'applied event retry was not idempotent: %', v_result;
  end if;
  v_result := public.apply_vector_event(
    v_user_1, 'second-sense', v_device, v_event_key, repeat('e', 64),
    3, 'score', '{"mode":"dedup","challengeId":null,"value":121}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'code' <> 'VECTOR_IDEMPOTENCY_REUSED'
     or (select score from public.game_scores
         where user_id = v_user_1 and game_id = 'second-sense' and mode = 'dedup') <> 120 then
    raise exception 'event idempotency key was reused with a new payload: %', v_result;
  end if;

  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('3', 64),
    3, 'achievement', '{"achievementId":"first-run"}'::jsonb, statement_timestamp()
  );
  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('4', 64),
    4, 'achievement', '{"achievementId":"first-run"}'::jsonb, statement_timestamp()
  );
  if (select count(*) from public.game_achievements
      where user_id = v_user_1 and achievement_id = 'first-run') <> 1 then
    raise exception 'achievement set-union merge failed';
  end if;

  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('5', 64),
    5, 'counter', '{"counterId":"plays","delta":2}'::jsonb, statement_timestamp()
  );
  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('6', 64),
    6, 'counter', '{"counterId":"plays","delta":3}'::jsonb, statement_timestamp()
  );
  if (select (counters->>'second-sense:plays')::integer from public.game_profiles
      where user_id = v_user_1) <> 5 then
    raise exception 'monotonic counter merge failed';
  end if;
  perform public.apply_vector_event(
    v_user_1, 'brickrise', v_device, gen_random_uuid(), repeat('7', 64),
    7, 'counter', '{"counterId":"plays","delta":7}'::jsonb, statement_timestamp()
  );
  if (select (counters->>'second-sense:plays')::integer from public.game_profiles
      where user_id = v_user_1) <> 5
     or (select (counters->>'brickrise:plays')::integer from public.game_profiles
         where user_id = v_user_1) <> 7 then
    raise exception 'counter namespaces collided across games';
  end if;
  update public.game_profiles
  set counters = jsonb_set(
    counters,
    array['neon-rift:overflow'],
    to_jsonb(9007199254740991::bigint),
    true
  )
  where user_id = v_user_1;
  v_result := public.apply_vector_event(
    v_user_1, 'neon-rift', v_device, gen_random_uuid(), repeat('c', 64),
    8, 'counter', '{"counterId":"overflow","delta":1}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'code' <> 'VECTOR_COUNTER_OVERFLOW'
     or (v_result->>'authoritativeValue')::bigint <> 9007199254740991 then
    raise exception 'counter overflow did not return authoritative truth: %', v_result;
  end if;
  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('8', 64),
    7, 'settings',
    '{"values":{"volume":0.2},"clocks":{"volume":{"at":"2026-07-16T10:00:00.000Z","deviceId":"device-a"}}}'::jsonb,
    statement_timestamp()
  );
  perform public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('9', 64),
    8, 'settings',
    '{"values":{"volume":0.9},"clocks":{"volume":{"at":"2026-07-16T09:00:00.000Z","deviceId":"device-z"}}}'::jsonb,
    statement_timestamp()
  );
  v_result := public.apply_vector_event(
    v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('a', 64),
    9, 'settings',
    '{"values":{"volume":0.8},"clocks":{"volume":{"at":"2026-07-16T10:00:00.000Z","deviceId":"device-z"}}}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'status' <> 'applied'
     or (v_result->>'serverRevision')::bigint <= 0
     or v_result ? 'authoritativeValue'
     or (select settings->'volume' from public.game_profiles where user_id = v_user_1) <> '0.8'::jsonb then
    raise exception 'per-field settings clock merge or response shape failed: %', v_result;
  end if;
  v_result := public.apply_vector_event(
    v_user_1, 'second-sense', v_device, v_future_key, repeat('f', 64),
    10, 'settings',
    '{"values":{"volume":1},"clocks":{"volume":{"at":"2999-01-01T00:00:00.000Z","deviceId":"device-z"}}}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'code' <> 'VECTOR_SETTING_CLOCK_FUTURE'
     or (select settings->'volume' from public.game_profiles where user_id = v_user_1) <> '0.8'::jsonb then
    raise exception 'far-future setting clock pinned LWW state: %', v_result;
  end if;
  v_result := public.apply_vector_event(
    v_user_1, 'second-sense', v_device, v_future_key, repeat('f', 64),
    10, 'settings',
    '{"values":{"volume":1},"clocks":{"volume":{"at":"2999-01-01T00:00:00.000Z","deviceId":"device-z"}}}'::jsonb,
    statement_timestamp()
  );
  if v_result->>'status' <> 'rejected'
     or v_result->>'code' <> 'VECTOR_SETTING_CLOCK_FUTURE' then
    raise exception 'far-future clock retry changed its terminal outcome: %', v_result;
  end if;

  v_result := public.sync_vector_save(
    v_user_1, 'time-to-fly', v_device, gen_random_uuid(), repeat('a', 64),
    'envelope', '1.0.0', 1, 0, 1, repeat('a', 64), 'seed-a',
    '{"same":true}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'applied' then
    raise exception 'envelope baseline save failed: %', v_result;
  end if;
  v_result := public.sync_vector_save(
    v_user_1, 'time-to-fly', v_device, gen_random_uuid(), repeat('b', 64),
    'envelope', '2.0.0', 2, 1, 2, repeat('a', 64), 'seed-b',
    '{"same":true}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'applied'
     or (v_result->>'serverRevision')::bigint <> 2
     or (select game_version from public.game_saves
         where user_id = v_user_1 and game_id = 'time-to-fly' and slot_id = 'envelope') <> '2.0.0'
     or (select seed from public.game_saves
         where user_id = v_user_1 and game_id = 'time-to-fly' and slot_id = 'envelope') <> 'seed-b' then
    raise exception 'same-state checksum bypassed envelope update: %', v_result;
  end if;

  perform public.sync_vector_save(
    v_user_2, 'second-sense', v_device, gen_random_uuid(), repeat('7', 64),
    'main', '1.0.0', 1, 0, 1, repeat('7', 64), null,
    '{"owner":2}'::jsonb, statement_timestamp()
  );
  perform public.apply_vector_event(
    v_user_2, 'second-sense', v_device, gen_random_uuid(), repeat('b', 64),
    2, 'score', '{"mode":"solo","challengeId":null,"value":200}'::jsonb,
    statement_timestamp()
  );
  perform public.apply_vector_event(
    v_user_2, 'second-sense', v_device, gen_random_uuid(), repeat('c', 64),
    3, 'achievement', '{"achievementId":"second-owner"}'::jsonb,
    statement_timestamp()
  );
  v_result := public.sync_vector_save(
    v_user_2, 'second-sense', 'device-sql-test-2', gen_random_uuid(), repeat('d', 64),
    'main', '1.0.0', 1, 0, 4, repeat('6', 64), null,
    '{"owner":"two-conflict"}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'conflict' then
    raise exception 'second-owner fork conflict was not preserved: %', v_result;
  end if;
  v_conflict_id := (v_result->>'conflictId')::uuid;
  update public.game_saves
  set checksum = repeat('5', 64), state = '{"owner":"new-current"}'::jsonb
  where user_id = v_user_2 and game_id = 'second-sense' and slot_id = 'main';
  perform public.sync_vector_save(
    v_user_2, 'second-sense', v_device, gen_random_uuid(), repeat('3', 64),
    'soft-target', '1.0.0', 1, 0, 1, repeat('3', 64), null,
    '{"soft":true}'::jsonb, statement_timestamp()
  );
  update public.game_saves
  set deleted_at = statement_timestamp()
  where user_id = v_user_2 and game_id = 'second-sense' and slot_id = 'soft-target';
  v_result := public.resolve_vector_conflict(
    v_user_2, v_conflict_id, gen_random_uuid(), repeat('3', 64),
    1, 'fork-local', 'soft-target'
  );
  if v_result->>'code' <> 'VECTOR_CONFLICT_TARGET_EXISTS'
     or (select status from public.game_save_conflicts where id = v_conflict_id) <> 'open' then
    raise exception 'fork-local collided with a soft-deleted unique slot: %', v_result;
  end if;
  v_result := public.resolve_vector_conflict(
    v_user_2, v_conflict_id, gen_random_uuid(), repeat('4', 64),
    1, 'fork-local', 'fork-after-change'
  );
  if v_result->>'status' <> 'applied'
     or (select state from public.game_saves
         where user_id = v_user_2 and game_id = 'second-sense' and slot_id = 'main')
        <> '{"owner":"new-current"}'::jsonb
     or (select state from public.game_saves
         where user_id = v_user_2 and game_id = 'second-sense' and slot_id = 'fork-after-change')
        <> '{"owner":"two-conflict"}'::jsonb then
    raise exception 'fork-local did not preserve both intended branches: %', v_result;
  end if;

  v_result := public.sync_vector_save(
    v_user_2, 'brickrise', v_device, gen_random_uuid(), repeat('a', 64),
    'missing-at-preview', '1.0.0', 1, 1, 1, repeat('a', 64), null,
    '{"branch":"local"}'::jsonb, statement_timestamp()
  );
  if v_result->>'status' <> 'conflict' then
    raise exception 'missing-server conflict was not preserved: %', v_result;
  end if;
  v_conflict_id := (v_result->>'conflictId')::uuid;
  -- The sync RPC blocks writes while a conflict is open. Inject a concurrent
  -- branch directly to prove resolution still rejects stale preview state.
  insert into public.game_saves (
    user_id, game_id, slot_id, game_version, save_schema_version,
    server_revision, client_revision, device_id, checksum, seed, state,
    source_event_id, client_updated_at, updated_at, deleted_at
  ) values (
    v_user_2, 'brickrise', 'missing-at-preview', '1.0.0', 1,
    1, 1, v_device, repeat('b', 64), null, '{"branch":"appeared"}'::jsonb,
    (select id from public.game_events
     where user_id = v_user_2 and game_id = 'brickrise'
     order by created_at desc, id desc limit 1),
    statement_timestamp(), statement_timestamp(), null
  );
  v_result := public.resolve_vector_conflict(
    v_user_2, v_conflict_id, gen_random_uuid(), repeat('c', 64),
    1, 'accept-server', null
  );
  if v_result->>'code' <> 'VECTOR_CONFLICT_STALE'
     or (select status from public.game_save_conflicts where id = v_conflict_id) <> 'open' then
    raise exception 'accept-server ignored a server branch that appeared after preview: %', v_result;
  end if;

  begin
    perform public.apply_vector_event(
      v_user_1, 'second-sense', v_device, gen_random_uuid(), repeat('e', 64),
      10, 'settings',
      jsonb_build_object('blob', repeat('x', 8200)),
      statement_timestamp()
    );
    raise exception 'oversized event payload was accepted';
  exception
    when check_violation then null;
  end;

  begin
    perform public.sync_vector_save(
      v_user_1, 'brickrise', v_device, gen_random_uuid(), repeat('f', 64),
      'oversized', '1.0.0', 1, 0, 11, repeat('f', 64), null,
      jsonb_build_object('blob', repeat('x', 262200)), statement_timestamp()
    );
    raise exception 'oversized save state was accepted';
  exception
    when check_violation then null;
  end;

  foreach v_table in array array[
    'game_profiles', 'game_saves', 'game_events', 'game_scores',
    'game_achievements', 'game_save_conflicts'
  ] loop
    if not has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') then
      raise exception 'authenticated SELECT missing on %', v_table;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_table_privilege(v_role, 'public.' || v_table, 'INSERT')
         or has_table_privilege(v_role, 'public.' || v_table, 'UPDATE')
         or has_table_privilege(v_role, 'public.' || v_table, 'DELETE')
         or has_table_privilege(v_role, 'public.' || v_table, 'TRUNCATE') then
        raise exception '% DML privilege leaked on %', v_role, v_table;
      end if;
    end loop;
    if not has_table_privilege('service_role', 'public.' || v_table, 'SELECT')
       or not has_table_privilege('service_role', 'public.' || v_table, 'INSERT')
       or not has_table_privilege('service_role', 'public.' || v_table, 'UPDATE')
       or not has_table_privilege('service_role', 'public.' || v_table, 'DELETE') then
      raise exception 'service_role table privilege missing on %', v_table;
    end if;
    if not (
      select relrowsecurity
      from pg_catalog.pg_class
      where oid = ('public.' || v_table)::regclass
    ) then
      raise exception 'RLS is not enabled on %', v_table;
    end if;
  end loop;

  foreach v_function in array array[
    'public.sync_vector_save(uuid,text,text,uuid,text,text,text,integer,bigint,bigint,text,text,jsonb,timestamptz)',
    'public.apply_vector_event(uuid,text,text,uuid,text,bigint,text,jsonb,timestamptz)',
    'public.resolve_vector_conflict(uuid,uuid,uuid,text,bigint,text,text)'
  ] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_function, 'EXECUTE') then
        raise exception '% RPC execution privilege leaked on %', v_role, v_function;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_function, 'EXECUTE') then
      raise exception 'service_role RPC execution missing on %', v_function;
    end if;
  end loop;
end;
$$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select user_id from vector_test_users where ordinal = 1),
    'role', 'authenticated'
  )::text,
  true
);
set local role authenticated;

do $$
declare
  v_table text;
  v_has_own boolean;
  v_has_other boolean;
begin
  foreach v_table in array array[
    'game_profiles', 'game_saves', 'game_events', 'game_scores',
    'game_achievements', 'game_save_conflicts'
  ] loop
    execute format(
      'select exists (select 1 from public.%I where user_id = auth.uid())',
      v_table
    ) into v_has_own;
    execute format(
      'select exists (select 1 from public.%I where user_id <> auth.uid())',
      v_table
    ) into v_has_other;
    if not v_has_own then
      raise exception 'RLS hid owner rows from %', v_table;
    end if;
    if v_has_other then
      raise exception 'RLS exposed cross-owner rows from %', v_table;
    end if;
  end loop;
end;
$$;

reset role;
rollback;

\echo 'VECTOR persistence SQL tests passed'
