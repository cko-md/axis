import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DATABASE_PREFIX = "axis_order_validation_";
const root = resolve(import.meta.dirname, "..");
const migration = resolve(
  root,
  "supabase/migrations/20260809210000_fund_order_intents_and_execution_receipts.sql",
);
const baseUrl = new URL(
  process.env.AXIS_ORDER_INTENT_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
if (!["postgres:", "postgresql:"].includes(baseUrl.protocol)) {
  throw new Error("AXIS_ORDER_INTENT_DB_URL must be a PostgreSQL URL");
}
if (decodeURIComponent(baseUrl.pathname) !== "/postgres") {
  throw new Error("validator base URL must target the postgres maintenance database");
}

const psqlCandidates = [
  process.env.PSQL_BIN,
  "/opt/homebrew/opt/libpq/bin/psql",
  "/opt/homebrew/Cellar/libpq/18.4/bin/psql",
  "psql",
].filter(Boolean);
const psql = psqlCandidates.find((candidate) => candidate === "psql" || existsSync(candidate));
if (!psql) throw new Error("psql was not found; set PSQL_BIN");

const databaseName = `${DATABASE_PREFIX}${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
if (!new RegExp(`^${DATABASE_PREFIX}[0-9]+_[0-9a-f]{8}$`).test(databaseName)) {
  throw new Error("refusing unsafe disposable database name");
}
const disposableUrl = new URL(baseUrl);
disposableUrl.pathname = `/${databaseName}`;
let created = false;

function run(url, sql, { expectFailure = false, label = "SQL probe" } = {}) {
  const result = spawnSync(
    psql,
    [url.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-q"],
    { input: sql, encoding: "utf8", env: process.env },
  );
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 4000);
    throw new Error(`${label} ${expectFailure ? "unexpectedly succeeded" : "failed"}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function assertScalar(sql, expected, label) {
  const output = run(
    disposableUrl,
    `\\pset tuples_only on\n\\pset format unaligned\n${sql}`,
    { label },
  );
  if (output !== expected) throw new Error(`${label}: expected ${expected}, received ${output}`);
}

const baselineSql = `
create schema extensions;
create extension pgcrypto with schema extensions;
create function public.gen_random_uuid() returns uuid
language sql volatile as $$ select extensions.gen_random_uuid() $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  action_class text not null,
  requirement text not null,
  reasons text[] not null default '{}',
  proposed_action jsonb not null,
  status text not null,
  step_up_verified_at timestamptz,
  decided_at timestamptz,
  expires_at timestamptz,
  scope text not null default 'one_time',
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.fund_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null,
  item_id text,
  institution text,
  mask text,
  status text not null default 'linked',
  authority text not null default 'legacy_unknown',
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.fund_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  kind text not null,
  symbol text,
  name text,
  shares numeric not null default 0,
  price numeric not null default 0,
  amount numeric not null default 0,
  fee numeric not null default 0,
  source text not null default 'manual',
  note text,
  executed_at timestamptz not null default now(),
  provider_record_id text,
  retrieved_at timestamptz,
  currency text not null default 'USD',
  reconciliation_state text,
  created_at timestamptz not null default now()
);

grant all on public.approvals, public.fund_connections, public.fund_transactions to service_role;
grant select, insert, update, delete on public.fund_transactions to authenticated;
insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
`;

try {
  run(baseUrl, `create database "${databaseName}"`, { label: "create disposable database" });
  created = true;
  run(disposableUrl, baselineSql, { label: "create order-intent baseline" });
  run(disposableUrl, readFileSync(migration, "utf8"), { label: "apply order-intent migration" });

  assertScalar(
    "select (has_table_privilege('service_role','public.fund_order_intents','INSERT') and not has_table_privilege('service_role','public.fund_order_intents','UPDATE') and not has_table_privilege('service_role','public.fund_order_intents','DELETE') and not has_table_privilege('service_role','public.fund_order_intents','TRUNCATE'))::text;",
    "true",
    "service intent privilege contract",
  );
  assertScalar(
    "select (not has_table_privilege('authenticated','public.fund_order_intents','INSERT') and not has_table_privilege('authenticated','public.fund_order_intents','UPDATE') and not has_table_privilege('authenticated','public.fund_order_intents','DELETE'))::text;",
    "true",
    "owner intent write denial",
  );
  assertScalar(
    "select (not has_table_privilege('service_role','public.fund_order_submissions','INSERT') and not has_table_privilege('service_role','public.fund_execution_receipts','INSERT') and not has_table_privilege('service_role','public.fund_transactions','INSERT'))::text;",
    "true",
    "single execution materialization boundary",
  );
  assertScalar(
    "select has_table_privilege('authenticated','public.fund_transactions','INSERT')::text;",
    "true",
    "pre-application legacy transaction compatibility",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.role='authenticated';
    set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
    insert into public.fund_transactions (
      id,user_id,kind,symbol,name,shares,price,amount,fee,source
    ) values (
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '11111111-1111-4111-8111-111111111111',
      'buy','AAPL','Apple',1,10,-10,0,'manual'
    );
    delete from public.fund_transactions
    where id='ffffffff-ffff-4fff-8fff-ffffffffffff';
  `, { label: "legacy unverified transaction compatibility" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.role='authenticated';
    set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
    insert into public.fund_transactions (
      user_id,kind,symbol,name,shares,price,amount,fee,source,
      execution_authority,order_intent_id,execution_receipt_id,
      provider_record_id,provider_receipt_hash,retrieved_at,reconciliation_state
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'buy','AAPL','Apple',1,10,-10,0,'public','provider_verified',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'forged-fill',repeat('f',64),now(),'matched'
    );
  `, { expectFailure: true, label: "legacy path provider execution forgery denial" });

  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    insert into public.fund_order_intents (
      id,user_id,provider,action_class,idempotency_key,payload_hash,symbol,side,
      order_type,quantity_units,quantity_scale,limit_price_minor,
      reference_price_minor,reference_price_source,estimated_notional_minor,
      currency,status
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'public','FINANCIAL_EXECUTION','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      repeat('a',64),'AAPL','buy','limit',1000000,1000000,1000,1000,
      'manual_estimate',1000,'USD','not_submitted'
    );
  `, { label: "service immutable intent insert" });
  run(disposableUrl, `
    update public.fund_order_intents set symbol='MSFT'
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  `, { expectFailure: true, label: "database-owner intent mutation denial" });
  run(disposableUrl, `
    set role service_role;
    insert into public.fund_order_submissions (
      user_id,intent_id,approval_id,connection_id,provider,
      provider_account_ref_hash,provider_order_id,submission_hash,
      submitted_at,acknowledged_at
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',gen_random_uuid(),gen_random_uuid(),
      'public',repeat('b',64),'order-denied',repeat('c',64),now(),now()
    );
  `, { expectFailure: true, label: "direct service submission denial" });

  run(disposableUrl, `
    insert into public.fund_connections (
      id,user_id,provider,item_id,status,authority,verified_at
    ) values (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '11111111-1111-4111-8111-111111111111',
      'public','account-1','linked','provider_verified',now()
    );
    insert into public.approvals (
      id,user_id,action_class,requirement,proposed_action,status,
      step_up_verified_at,decided_at,expires_at
    ) values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '11111111-1111-4111-8111-111111111111',
      'FINANCIAL_EXECUTION','approval_step_up',
      jsonb_build_object(
        'intentId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'target',jsonb_build_object('accountId','account-1')
      ),
      'executed',now(),now(),now()+interval '10 minutes'
    );
    insert into public.fund_order_submissions (
      id,user_id,intent_id,approval_id,connection_id,provider,
      provider_account_ref_hash,provider_order_id,submission_hash,
      submitted_at,acknowledged_at
    ) values (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc','public',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1',repeat('d',64),now(),now()
    );
  `, { label: "trusted future submission fixture" });

  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role='service_role';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1','fill-zero-price',repeat('0',64),100000,0,0,
      now(),now()
    );
  `, { expectFailure: true, label: "zero-price provider fill denial" });
  assertScalar(
    "select (select count(*) from public.fund_execution_receipts)::text || ':' || (select count(*) from public.fund_transactions)::text;",
    "0:0",
    "rejected zero-price fill leaves no financial record",
  );

  assertScalar(`
    set role service_role;
    set request.jwt.claim.role='service_role';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1','fill-limit',repeat('1',64),100000,1100,0,
      now(),now()
    )->>'outcome';
  `, "limit_price_violated", "limit-price enforcement");
  assertScalar(`
    set role service_role;
    set request.jwt.claim.role='service_role';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1','fill-time',repeat('2',64),100000,900,0,
      now()+interval '2 minutes',now()
    )->>'outcome';
  `, "invalid_chronology", "receipt chronology enforcement");
  assertScalar(`
    set role service_role;
    set request.jwt.claim.role='service_role';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1','fill-1',repeat('3',64),600000,900,5,
      now(),now()
    )->>'outcome';
  `, "created", "first verified partial fill");
  assertScalar(`
    set role service_role;
    set request.jwt.claim.role='service_role';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1','fill-1',repeat('3',64),600000,900,5,
      (select executed_at from public.fund_execution_receipts where provider_fill_id='fill-1'),
      (select retrieved_at from public.fund_execution_receipts where provider_fill_id='fill-1')
    )->>'outcome';
  `, "deduplicated", "exact fill replay deduplication");
  assertScalar(`
    set role service_role;
    set request.jwt.claim.role='service_role';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      encode(extensions.digest('account-1','sha256'),'hex'),
      'provider-order-1','fill-2',repeat('4',64),500000,900,0,
      now(),now()
    )->>'outcome';
  `, "quantity_exceeded", "cumulative fill cap");
  assertScalar(
    "select (select count(*) from public.fund_execution_receipts)::text || ':' || (select count(*) from public.fund_transactions)::text;",
    "1:1",
    "one receipt creates exactly one execution row",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.role='authenticated';
    set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
    select public.record_verified_fund_execution(
      '11111111-1111-4111-8111-111111111111',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',repeat('a',64),
      'provider-order-1','forged',repeat('5',64),1,1,0,now(),now()
    );
  `, { expectFailure: true, label: "authenticated receipt RPC denial" });

  process.stdout.write(`ORDER_INTENT_DB_VALIDATION_PASS ${databaseName}\n`);
} finally {
  if (created) {
    run(baseUrl, `drop database if exists "${databaseName}" with (force)`, {
      label: "drop disposable database",
    });
  }
}
