import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DATABASE_PREFIX = "axis_ft_privilege_validation_";
const root = resolve(import.meta.dirname, "..");
const migration = resolve(
  root,
  "supabase/migrations/20260809220000_financial_truth_expansion_privilege_repair.sql",
);
const baseUrl = new URL(
  process.env.AXIS_FINANCIAL_TRUTH_PRIVILEGE_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
if (!["postgres:", "postgresql:"].includes(baseUrl.protocol)) {
  throw new Error("AXIS_FINANCIAL_TRUTH_PRIVILEGE_DB_URL must be a PostgreSQL URL");
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
  if (output !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${output}`);
  }
}

const financialTables = [
  "fund_bank_transactions",
  "fund_category_budgets",
  "fund_connections",
  "fund_execution_receipts",
  "fund_holdings",
  "fund_liabilities",
  "fund_order_intents",
  "fund_order_submissions",
  "fund_provider_coverage",
  "fund_recurring_transactions",
  "fund_transactions",
  "fund_watchlist",
  "integration_delivery_outbox",
  "net_worth_snapshots",
  "net_worth_snapshot_revisions",
];

const baselineSql = `
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
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

${financialTables
  .filter((table) => table !== "net_worth_snapshots")
  .map((table) => `create table public.${table} (id uuid primary key, user_id uuid);`)
  .join("\n")}
create table public.net_worth_snapshots (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  net_worth numeric not null,
  authority text not null
);
alter table public.net_worth_snapshots enable row level security;
create policy net_worth_snapshots_select_own on public.net_worth_snapshots
  for select to authenticated using ((select auth.uid()) = user_id);
create view public.net_worth_snapshots_exact as
select id, user_id, net_worth
from public.net_worth_snapshots
where authority = 'provider';

grant all on table ${financialTables.map((table) => `public.${table}`).join(", ")}
  to public, anon, authenticated, service_role;
grant all on table public.net_worth_snapshots_exact
  to public, anon, authenticated, service_role;

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
insert into public.net_worth_snapshots(id,user_id,net_worth,authority) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',100,'provider'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',200,'provider');
`;

try {
  run(baseUrl, `create database "${databaseName}"`, { label: "create disposable database" });
  created = true;
  run(disposableUrl, baselineSql, { label: "create inherited-privilege baseline" });

  assertScalar(
    `select bool_and(has_table_privilege('anon', 'public.' || object_name, 'SELECT,INSERT,UPDATE,DELETE'))::text
     from unnest(array[${financialTables.map((table) => `'${table}'`).join(",")}]) object_name;`,
    "true",
    "baseline reproduces broad anonymous grants",
  );

  run(disposableUrl, readFileSync(migration, "utf8"), { label: "apply privilege repair" });

  assertScalar(
    `select (not bool_or(has_table_privilege('anon', 'public.' || object_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text
     from unnest(array[${financialTables.map((table) => `'${table}'`).join(",")}]) object_name;`,
    "true",
    "anonymous financial table privileges revoked",
  );
  assertScalar(
    "select (not has_table_privilege('anon','public.net_worth_snapshots_exact','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))::text;",
    "true",
    "anonymous exact-view privileges revoked",
  );
  assertScalar(
    `select (
       has_table_privilege('authenticated','public.net_worth_snapshots_exact','SELECT')
       and not has_table_privilege('authenticated','public.net_worth_snapshots_exact','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       and has_table_privilege('service_role','public.net_worth_snapshots_exact','SELECT')
       and not has_table_privilege('service_role','public.net_worth_snapshots_exact','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     )::text;`,
    "true",
    "exact-view grants are select-only",
  );
  assertScalar(
    `select (
       coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
       and coalesce(c.reloptions, '{}'::text[]) @> array['security_barrier=true']
     )::text
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'net_worth_snapshots_exact';`,
    "true",
    "exact-view security options",
  );
  assertScalar(
    `set role authenticated;
     set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
     select string_agg(net_worth::text, ',') from public.net_worth_snapshots_exact;`,
    "100",
    "security-invoker view preserves owner isolation",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
    update public.net_worth_snapshots_exact set net_worth=0;
  `, { expectFailure: true, label: "authenticated exact-view mutation denial" });
  run(disposableUrl, `
    set role anon;
    select * from public.net_worth_snapshots_exact;
  `, { expectFailure: true, label: "anonymous exact-view read denial" });

  process.stdout.write(`FINANCIAL_TRUTH_PRIVILEGE_REPAIR_DB_VALIDATION_PASS ${databaseName}\n`);
} finally {
  if (created) {
    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error("refusing to drop non-validator database");
    }
    run(baseUrl, `drop database if exists "${databaseName}" with (force)`, {
      label: "drop disposable database",
    });
  }
}
