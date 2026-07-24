import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DATABASE_PREFIX = "axis_ft_validation_";
const root = resolve(import.meta.dirname, "..");
const migration = resolve(
  root,
  "supabase/migrations/20260723090000_net_worth_snapshots_authority_provenance.sql",
);
const baseUrl = new URL(
  process.env.AXIS_FINANCIAL_TRUTH_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
if (!["postgres:", "postgresql:"].includes(baseUrl.protocol)) {
  throw new Error("AXIS_FINANCIAL_TRUTH_DB_URL must be a PostgreSQL URL");
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
const psql = psqlCandidates.find((candidate) =>
  candidate === "psql" || existsSync(candidate),
);
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
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create function public.gen_random_uuid() returns uuid
language sql volatile as $$ select extensions.gen_random_uuid() $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema extensions to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create table public.fund_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null check (provider in ('plaid','public')),
  item_id text,
  institution text,
  mask text,
  status text not null default 'linked' check (status in ('linked','error','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  access_token_enc text,
  refresh_token_enc text,
  unique(user_id, provider, item_id)
);
alter table public.fund_connections enable row level security;
create policy "fund_connections_select_own" on public.fund_connections for select using (auth.uid() = user_id);
create policy "fund_connections_insert_own" on public.fund_connections for insert with check (auth.uid() = user_id);
create policy "fund_connections_update_own" on public.fund_connections for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_connections_delete_own" on public.fund_connections for delete using (auth.uid() = user_id);
grant all on public.fund_connections to authenticated, service_role;

create table public.fund_bank_transactions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.fund_connections(id) on delete set null,
  plaid_transaction_id text not null,
  account_id text,
  merchant_name text,
  raw_name text,
  amount numeric not null default 0,
  iso_currency_code text not null default 'USD',
  plaid_category text,
  custom_category text,
  tags text[] not null default '{}',
  is_transfer boolean not null default false,
  excluded_from_budget boolean not null default false,
  reviewed boolean not null default false,
  pending boolean not null default false,
  posted_date date not null,
  authorized_date date,
  split_parent_id uuid references public.fund_bank_transactions(id) on delete cascade,
  notes text,
  retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, plaid_transaction_id)
);
alter table public.fund_bank_transactions enable row level security;
create policy "fund_bank_transactions_select_own"
  on public.fund_bank_transactions for select using (auth.uid() = user_id);
create policy "fund_bank_transactions_insert_own"
  on public.fund_bank_transactions for insert with check (auth.uid() = user_id);
create policy "fund_bank_transactions_update_own"
  on public.fund_bank_transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_bank_transactions_delete_own"
  on public.fund_bank_transactions for delete using (auth.uid() = user_id);
grant all on public.fund_bank_transactions to authenticated, service_role;

create table public.fund_category_budgets (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  monthly_limit numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, category)
);
alter table public.fund_category_budgets enable row level security;
create policy "fund_category_budgets_select_own"
  on public.fund_category_budgets for select using (auth.uid() = user_id);
create policy "fund_category_budgets_insert_own"
  on public.fund_category_budgets for insert with check (auth.uid() = user_id);
create policy "fund_category_budgets_update_own"
  on public.fund_category_budgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_category_budgets_delete_own"
  on public.fund_category_budgets for delete using (auth.uid() = user_id);
grant all on public.fund_category_budgets to authenticated, service_role;

create table public.fund_recurring_transactions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_name text not null,
  category text,
  expected_amount numeric not null default 0,
  cadence text not null default 'monthly'
    check (cadence in ('weekly','biweekly','monthly','quarterly','annual')),
  next_expected_date date,
  last_seen_date date,
  status text not null default 'active'
    check (status in ('active','cancelled','irregular')),
  source text not null default 'detected'
    check (source in ('detected','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, merchant_name)
);
alter table public.fund_recurring_transactions enable row level security;
create policy "fund_recurring_transactions_select_own"
  on public.fund_recurring_transactions for select using (auth.uid() = user_id);
create policy "fund_recurring_transactions_insert_own"
  on public.fund_recurring_transactions for insert with check (auth.uid() = user_id);
create policy "fund_recurring_transactions_update_own"
  on public.fund_recurring_transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_recurring_transactions_delete_own"
  on public.fund_recurring_transactions for delete using (auth.uid() = user_id);
grant all on public.fund_recurring_transactions to authenticated, service_role;

create table public.fund_holdings (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  symbol text not null,
  name text not null,
  shares numeric not null default 0,
  cost_basis numeric not null default 0,
  sort_order int not null default 0,
  source text not null default 'manual' check (source in ('manual','plaid','public')),
  connection_id uuid references public.fund_connections(id),
  provider text,
  provider_record_id text,
  retrieved_at timestamptz,
  effective_at timestamptz,
  currency text not null default 'USD',
  reconciliation_state text check (reconciliation_state in ('matched','partial','conflicting','missing','stale','pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, symbol)
);
alter table public.fund_holdings enable row level security;
create policy "fund_holdings_select_own" on public.fund_holdings for select using (auth.uid() = user_id);
create policy "fund_holdings_insert_own" on public.fund_holdings for insert with check (auth.uid() = user_id);
create policy "fund_holdings_update_own" on public.fund_holdings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_holdings_delete_own" on public.fund_holdings for delete using (auth.uid() = user_id);
grant all on public.fund_holdings to authenticated, service_role;

create table public.fund_liabilities (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  connection_id uuid references public.fund_connections(id),
  kind text not null default 'credit_card',
  name text not null,
  balance numeric not null default 0,
  apr numeric,
  minimum_payment numeric,
  due_date date,
  source text not null default 'manual' check (source in ('manual','plaid')),
  provider text,
  provider_record_id text,
  retrieved_at timestamptz,
  effective_at timestamptz,
  currency text not null default 'USD',
  reconciliation_state text check (reconciliation_state in ('matched','partial','conflicting','missing','stale','pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.fund_liabilities enable row level security;
create policy "fund_liabilities_select_own" on public.fund_liabilities for select using (auth.uid() = user_id);
create policy "fund_liabilities_insert_own" on public.fund_liabilities for insert with check (auth.uid() = user_id);
create policy "fund_liabilities_update_own" on public.fund_liabilities for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fund_liabilities_delete_own" on public.fund_liabilities for delete using (auth.uid() = user_id);
grant all on public.fund_liabilities to authenticated, service_role;

create table public.net_worth_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  captured_on date not null default current_date,
  cash numeric not null default 0,
  invested numeric not null default 0,
  liabilities numeric not null default 0,
  net_worth numeric not null default 0,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, captured_on)
);
alter table public.net_worth_snapshots enable row level security;
create policy "net_worth_snapshots_select_own" on public.net_worth_snapshots for select using (auth.uid() = user_id);
create policy "net_worth_snapshots_insert_own" on public.net_worth_snapshots for insert with check (auth.uid() = user_id);
create policy "net_worth_snapshots_update_own" on public.net_worth_snapshots for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "net_worth_snapshots_delete_own" on public.net_worth_snapshots for delete using (auth.uid() = user_id);
grant all on public.net_worth_snapshots to authenticated, service_role;

create table public.integration_delivery_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null check (provider = 'make'),
  event_type text not null,
  dedupe_key_hash text not null,
  payload_ciphertext text not null,
  status text not null default 'pending'
    constraint integration_delivery_outbox_status_check
    check (status in ('pending','delivered','failed','dead_letter')),
  attempt_count integer not null default 0,
  last_error_code text,
  last_http_status integer,
  claim_token uuid,
  locked_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_delivery_outbox_claim_pair_check check (
    (claim_token is null and locked_at is null) or (claim_token is not null and locked_at is not null)
  ),
  constraint integration_delivery_outbox_claim_status_check check (claim_token is null or status = 'pending'),
  constraint integration_delivery_outbox_delivered_check check (
    (status = 'delivered' and delivered_at is not null) or (status <> 'delivered' and delivered_at is null)
  ),
  unique(user_id, provider, dedupe_key_hash)
);
alter table public.integration_delivery_outbox enable row level security;
create policy "integration_delivery_outbox_select_own" on public.integration_delivery_outbox
  for select to authenticated using (auth.uid() = user_id);
grant all on public.integration_delivery_outbox to service_role;

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
insert into public.fund_category_budgets (user_id, category, monthly_limit)
values ('11111111-1111-4111-8111-111111111111', 'LEGACY_ZERO', 0);
insert into public.integration_delivery_outbox (
  user_id, provider, event_type, dedupe_key_hash, payload_ciphertext,
  status, delivered_at
) values (
  '11111111-1111-4111-8111-111111111111', 'make', 'daily_brief',
  repeat('a',64), 'ciphertext', 'delivered', now()
);
`;

try {
  run(baseUrl, `create database "${databaseName}"`, { label: "create disposable database" });
  created = true;
  run(disposableUrl, baselineSql, { label: "create financial-truth baseline" });
  const migrationSql = readFileSync(migration, "utf8");
  run(disposableUrl, migrationSql, { label: "apply financial-truth migration" });
  assertScalar(
    "select currency || ':' || monthly_limit::text from fund_category_budgets where category='LEGACY_ZERO';",
    "USD:0",
    "legacy budget currency backfill and disabled-zero semantics",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.role = 'authenticated';
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    insert into public.fund_category_budgets (user_id,category,monthly_limit,currency)
    values
      ('11111111-1111-4111-8111-111111111111','TRAVEL','100.00','USD'),
      ('11111111-1111-4111-8111-111111111111','TRAVEL','100.00','EUR');
  `, { label: "currency-partitioned category budgets" });
  assertScalar(
    "select count(*)::text from fund_category_budgets where category='TRAVEL';",
    "2",
    "same category remains separate by currency",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.role = 'authenticated';
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    insert into public.fund_category_budgets (user_id,category,monthly_limit,currency)
    values ('11111111-1111-4111-8111-111111111111','TRAVEL','1.00','USD');
  `, { expectFailure: true, label: "duplicate category currency budget rejection" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.role = 'authenticated';
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    insert into public.fund_category_budgets (user_id,category,monthly_limit,currency)
    values ('11111111-1111-4111-8111-111111111111','TOO_LARGE','100000000001','USD');
  `, { expectFailure: true, label: "unsafe budget magnitude rejection" });

  assertScalar(
    "select status || ':' || (accepted_at is not null)::text || ':' || (delivered_at is null)::text from integration_delivery_outbox;",
    "accepted:true:true",
    "legacy Make delivery downgrade",
  );

  run(disposableUrl, `
    set role service_role;
    insert into public.fund_connections (
      id,user_id,provider,item_id,status,authority,verified_at,access_token_enc
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'plaid','item-1','linked','provider_verified',now(),'encrypted'
    );
    insert into public.fund_holdings (
      id,user_id,symbol,name,shares,cost_basis,source,connection_id,provider,
      provider_record_id,retrieved_at,currency,reconciliation_state,authority,
      generation_id
    ) values (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      'AAPL','Apple','1.25','100.00','plaid',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','plaid','position-1',now(),'USD','matched','provider',
      '44444444-4444-4444-8444-444444444444'
    );
    insert into public.fund_provider_coverage (
      user_id,connection_id,provider,component,complete,record_count,retrieved_at,
      generation_id,generation_hash
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','plaid','holdings',true,1,now(),
      '44444444-4444-4444-8444-444444444444',
      public.fund_holding_generation_hash(
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '44444444-4444-4444-8444-444444444444'
      )
    );
    insert into public.fund_liabilities (
      id,user_id,name,balance,source,connection_id,provider,provider_record_id,
      retrieved_at,currency,reconciliation_state,authority,generation_id
    ) values (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '11111111-1111-4111-8111-111111111111',
      'Card','10.00','plaid','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'plaid','liability-1',now(),'USD','matched','provider',
      '55555555-5555-4555-8555-555555555555'
    );
    insert into public.net_worth_snapshots (
      id,user_id,captured_on,cash,invested,liabilities,net_worth,computed_at,
      authority,snapshot_status,currency,calculation_version,calculation_hash,
      input_provenance,input_as_of
    ) values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '11111111-1111-4111-8111-111111111111',
      current_date,'20.00','100.00','10.00','110.00',now(),
      'provider','fresh','USD','financial-truth-v2',repeat('b',64),
      '[{"provider":"plaid"}]'::jsonb,now()
    );
  `, { label: "service-role authoritative inserts" });

  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    insert into public.fund_holdings (
      user_id,symbol,name,shares,cost_basis,source,provider,provider_record_id,
      connection_id,retrieved_at,reconciliation_state,authority
    ) values (
      '11111111-1111-4111-8111-111111111111','MSFT','Microsoft','1','50',
      'plaid','plaid','forged','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now(),'matched','provider'
    );
  `, { label: "authenticated manual-compatible insert" });
  assertScalar(
    "select authority || ':' || source || ':' || (provider is null)::text from fund_holdings where symbol='MSFT';",
    "manual:manual:true",
    "provider authority forgery coercion",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
    insert into public.fund_holdings (user_id,symbol,name,shares,cost_basis)
    values ('11111111-1111-4111-8111-111111111111','TSLA','Tesla','1','1');
  `, { expectFailure: true, label: "two-owner RLS isolation" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    update public.fund_holdings set shares=2 where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  `, { expectFailure: true, label: "provider holding client immutability" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    delete from public.fund_liabilities where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  `, { expectFailure: true, label: "provider liability client immutability" });
  run(disposableUrl, `
    set role service_role;
    insert into public.fund_holdings (
      user_id,symbol,name,shares,cost_basis,source,connection_id,provider,
      provider_record_id,retrieved_at,currency,reconciliation_state,authority
    ) values (
      '11111111-1111-4111-8111-111111111111','OLD','Old','1','1','plaid',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','plaid','old-1',
      now()-interval '3 days','USD','matched','provider'
    );
  `, { expectFailure: true, label: "stale provider holding rejection" });

  const firstComputed = run(
    disposableUrl,
    "\\pset tuples_only on\n\\pset format unaligned\nselect computed_at::text from net_worth_snapshots where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';",
    { label: "read initial snapshot time" },
  );
  run(disposableUrl, `
    set role service_role;
    update public.net_worth_snapshots
    set computed_at = computed_at + interval '1 minute'
    where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  `, { label: "idempotent snapshot replay" });
  assertScalar(
    "select (computed_at::text = " + `'${firstComputed.replaceAll("'", "''")}')::text from net_worth_snapshots where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';`,
    "true",
    "idempotent replay preserves computed_at",
  );
  run(disposableUrl, `
    set role service_role;
    update public.net_worth_snapshots set cash='21.00', net_worth='111.00'
    where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  `, { expectFailure: true, label: "same-hash material mutation rejection" });
  run(disposableUrl, `
    set role service_role;
    update public.net_worth_snapshots
    set cash='21.00', net_worth='111.00', calculation_hash=repeat('c',64),
        computed_at=computed_at+interval '1 minute'
    where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  `, { label: "truthful same-day revision" });
  assertScalar(
    "select count(*)::text from net_worth_snapshot_revisions where snapshot_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';",
    "2",
    "snapshot revision append",
  );
  assertScalar(
    "select (not has_table_privilege('service_role','public.net_worth_snapshot_revisions','UPDATE') and not has_table_privilege('service_role','public.net_worth_snapshot_revisions','DELETE') and not has_table_privilege('service_role','public.net_worth_snapshot_revisions','TRUNCATE'))::text;",
    "true",
    "revision service-role least privilege",
  );
  run(disposableUrl, `
    set role service_role;
    update public.net_worth_snapshot_revisions set net_worth='0';
  `, { expectFailure: true, label: "append-only revision mutation" });
  assertScalar(
    "select (not has_column_privilege('authenticated','public.fund_connections','access_token_enc','SELECT') and not has_column_privilege('authenticated','public.fund_connections','refresh_token_enc','SELECT') and not has_column_privilege('authenticated','public.fund_connections','item_id','SELECT'))::text;",
    "true",
    "provider credential and identity non-disclosure",
  );
  assertScalar(
    "select (not has_table_privilege('authenticated','public.fund_connections','INSERT') and not has_table_privilege('authenticated','public.fund_connections','UPDATE') and not has_table_privilege('authenticated','public.fund_connections','DELETE'))::text;",
    "true",
    "provider connection owner mutation denial",
  );
  assertScalar(
    "set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'; select count(id)::text from public.fund_connections;",
    "1",
    "safe owner connection display",
  );
  assertScalar(
    "set role authenticated; set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'; select count(id)::text from public.fund_connections;",
    "0",
    "connection cross-user isolation",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
    update public.fund_connections set status='revoked'
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  `, { expectFailure: true, label: "direct connection mutation denial" });
  run(disposableUrl, `
    set role service_role;
    update public.fund_connections set institution='Server verified'
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and user_id='11111111-1111-4111-8111-111111111111';
  `, { label: "scoped server connection mutation success" });
  assertScalar(
    "select institution from public.fund_connections where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';",
    "Server verified",
    "scoped server path persisted",
  );

  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,
      current_date,
      now(),
      '52345678-1234-4234-8234-1234567890ab',
      (
        select jsonb_agg(jsonb_build_object(
          'plaid_transaction_id','bulk-' || generated,
          'account_id',repeat('a',255),
          'merchant_name',repeat('m',512),
          'raw_name',repeat('r',512),
          'amount','1.00',
          'amount_minor',100,
          'iso_currency_code','USD',
          'plaid_category',repeat('c',80),
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','52345678-1234-4234-8234-1234567890ab'
        ))
        from generate_series(1,4000) generated
      )
    );
  `, { expectFailure: true, label: "oversized RPC payload rejection" });
  assertScalar(
    "select (select count(*)::text from fund_provider_coverage where connection_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and component='transactions') || ':' || (select count(*)::text from fund_bank_transactions where authority='provider');",
    "0:0",
    "oversized publication rolls back atomically",
  );
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,
      current_date,
      now(),
      '12345678-1234-4234-8234-1234567890ab',
      jsonb_build_array(
        jsonb_build_object(
          'plaid_transaction_id','txn-debit',
          'account_id','account-a',
          'merchant_name','Transfer debit',
          'raw_name','Transfer debit',
          'amount','-10.01',
          'amount_minor',-1001,
          'iso_currency_code','USD',
          'plaid_category','TRANSFER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','12345678-1234-4234-8234-1234567890ab'
        ),
        jsonb_build_object(
          'plaid_transaction_id','txn-debit-2',
          'account_id','account-c',
          'merchant_name','Transfer debit duplicate amount',
          'raw_name','Transfer debit duplicate amount',
          'amount','-10.01',
          'amount_minor',-1001,
          'iso_currency_code','USD',
          'plaid_category','TRANSFER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','12345678-1234-4234-8234-1234567890ab'
        ),
        jsonb_build_object(
          'plaid_transaction_id','txn-credit',
          'account_id','account-b',
          'merchant_name','Transfer credit',
          'raw_name','Transfer credit',
          'amount','10.01',
          'amount_minor',1001,
          'iso_currency_code','USD',
          'plaid_category','TRANSFER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','12345678-1234-4234-8234-1234567890ab'
        ),
        jsonb_build_object(
          'plaid_transaction_id','txn-zero',
          'account_id','account-d',
          'merchant_name','Zero amount',
          'raw_name','Zero amount',
          'amount','0.00',
          'amount_minor',0,
          'iso_currency_code','USD',
          'plaid_category','TRANSFER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','12345678-1234-4234-8234-1234567890ab'
        ),
        jsonb_build_object(
          'plaid_transaction_id','txn-cross-currency',
          'account_id','account-e',
          'merchant_name','Euro credit',
          'raw_name','Euro credit',
          'amount','10.01',
          'amount_minor',1001,
          'iso_currency_code','EUR',
          'plaid_category','TRANSFER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','12345678-1234-4234-8234-1234567890ab'
        )
      )
    );
  `, { label: "service-role atomic transaction publication" });
  assertScalar(
    "select complete::text || ':' || record_count::text || ':' || (generation_hash ~ '^[0-9a-f]{64}$')::text from fund_provider_coverage where connection_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and component='transactions';",
    "true:5:true",
    "transaction generation coverage binding",
  );
  assertScalar(
    "select count(*)::text from fund_bank_transactions where generation_id='12345678-1234-4234-8234-1234567890ab' and is_transfer;",
    "2",
    "deterministic one-to-one transfer tagging excludes zero and cross-currency",
  );
  assertScalar(
    "set role service_role; set request.jwt.claim.role = 'service_role'; select available::text || ':' || (lineage_hash ~ '^[0-9a-f]{64}$')::text from public.check_fund_transaction_history_coverage('11111111-1111-4111-8111-111111111111', current_date - 90, current_date);",
    "true:true",
    "complete transaction history proof",
  );
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    insert into public.fund_recurring_transactions (
      user_id,merchant_name,expected_amount,currency,cadence,next_expected_date,
      last_seen_date,status,source,source_generations,source_generation_hash
    )
    select
      '11111111-1111-4111-8111-111111111111',
      'Detected service',
      '10.01',
      'USD',
      'monthly',
      current_date + 30,
      current_date,
      'active',
      'detected',
      verified.coverage,
      verified.lineage_hash
    from public.check_fund_transaction_history_coverage(
      '11111111-1111-4111-8111-111111111111',
      current_date - 90,
      current_date
    ) verified
    where verified.available;
  `, { label: "detected recurring lineage publication" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    update public.fund_recurring_transactions set expected_amount='1.00'
      where merchant_name='Detected service';
  `, { expectFailure: true, label: "detected recurring fact owner lock" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    update public.fund_recurring_transactions set status='cancelled'
      where merchant_name='Detected service';
  `, { label: "detected recurring owner review status" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    insert into public.fund_recurring_transactions (
      user_id,merchant_name,expected_amount,currency,source
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'Owner recurring','5.00','USD','detected'
    );
  `, { label: "owner recurring insert coercion" });
  assertScalar(
    "select source || ':' || (source_generation_hash is null)::text from fund_recurring_transactions where merchant_name='Owner recurring';",
    "manual:true",
    "owner recurring remains explicit manual authority",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    insert into public.fund_recurring_transactions (
      user_id,merchant_name,expected_amount,currency,source
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'Netflix','15.00','USD','manual'
    );
    reset role;
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    insert into public.fund_recurring_transactions (
      user_id,merchant_name,expected_amount,currency,cadence,source,
      source_generations,source_generation_hash
    )
    select
      '11111111-1111-4111-8111-111111111111',
      'Netflix','14.00','EUR','monthly','detected',
      verified.coverage,verified.lineage_hash
    from public.check_fund_transaction_history_coverage(
      '11111111-1111-4111-8111-111111111111',
      current_date-90,current_date
    ) verified
    where verified.available
    on conflict (user_id,merchant_name,currency,source) do update
      set expected_amount=excluded.expected_amount;
    insert into public.fund_recurring_transactions (
      user_id,merchant_name,expected_amount,currency,cadence,source,
      source_generations,source_generation_hash
    )
    select
      '11111111-1111-4111-8111-111111111111',
      'Netflix','14.00','EUR','monthly','detected',
      verified.coverage,verified.lineage_hash
    from public.check_fund_transaction_history_coverage(
      '11111111-1111-4111-8111-111111111111',
      current_date-90,current_date
    ) verified
    where verified.available
    on conflict (user_id,merchant_name,currency,source) do update
      set expected_amount=excluded.expected_amount;
  `, { label: "manual and detected recurring identity partition" });
  assertScalar(
    "select count(*)::text from public.fund_recurring_transactions where merchant_name='Netflix';",
    "2",
    "manual recurring survives detected cross-currency idempotence",
  );
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    do $probe$
    begin
      begin
        insert into public.fund_recurring_transactions (
          user_id,merchant_name,expected_amount,currency,cadence,source,
          source_generations,source_generation_hash
        )
        select
          '11111111-1111-4111-8111-111111111111',
          'Invalid currency','1.00','ZZZ','monthly','detected',
          verified.coverage,verified.lineage_hash
        from public.check_fund_transaction_history_coverage(
          '11111111-1111-4111-8111-111111111111',
          current_date-90,current_date
        ) verified
        where verified.available;
        raise exception 'invalid detected currency unexpectedly succeeded';
      exception
        when sqlstate '23514' then null;
      end;
    end
    $probe$;
  `, { label: "invalid detected currency SQLSTATE 23514" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,current_date,now(),
      '22345678-1234-4234-8234-1234567890ab','[]'::jsonb
    );
  `, { expectFailure: true, label: "authenticated transaction publication denial" });
  run(disposableUrl, `
    set role anon;
    set request.jwt.claim.role = 'anon';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,current_date,now(),
      '22345678-1234-4234-8234-1234567890ab','[]'::jsonb
    );
  `, { expectFailure: true, label: "anonymous transaction publication denial" });
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    select * from public.publish_fund_transaction_generation(
      '22222222-2222-4222-8222-222222222222',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,current_date,now(),
      '22345678-1234-4234-8234-1234567890ab','[]'::jsonb
    );
  `, { expectFailure: true, label: "cross-owner transaction publication denial" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    update public.fund_bank_transactions set amount='0.00'
      where plaid_transaction_id='txn-debit';
  `, { expectFailure: true, label: "provider transaction fact owner lock" });
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    update public.fund_bank_transactions
      set custom_category='OWNER_CATEGORY', reviewed=true
      where plaid_transaction_id='txn-debit';
  `, { label: "provider transaction annotation update" });
  assertScalar(
    "select amount::text || ':' || custom_category || ':' || reviewed::text from fund_bank_transactions where plaid_transaction_id='txn-debit';",
    "-10.01:OWNER_CATEGORY:true",
    "provider transaction fact preserved with owner annotations",
  );
  run(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
    set request.jwt.claim.role = 'authenticated';
    insert into public.fund_provider_coverage (
      user_id,connection_id,provider,component,complete,record_count,retrieved_at,
      window_start,window_end,generation_id,generation_hash
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','plaid','transactions',true,0,now(),
      current_date-90,current_date,'22345678-1234-4234-8234-1234567890ab',
      repeat('f',64)
    );
  `, { expectFailure: true, label: "owner forged transaction coverage denial" });
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    update public.fund_provider_coverage
      set generation_hash=repeat('f',64)
      where connection_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        and component='transactions';
  `, { expectFailure: true, label: "service forged transaction coverage denial" });
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,
      current_date,
      now(),
      '22345678-1234-4234-8234-1234567890ab',
      jsonb_build_array(
        jsonb_build_object(
          'plaid_transaction_id','rollback-valid',
          'account_id','account-a',
          'merchant_name','Valid first row',
          'raw_name','Valid first row',
          'amount','1.00',
          'amount_minor',100,
          'iso_currency_code','USD',
          'plaid_category','OTHER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','22345678-1234-4234-8234-1234567890ab'
        ),
        jsonb_build_object(
          'plaid_transaction_id','rollback-invalid',
          'account_id','account-b',
          'merchant_name','Invalid second row',
          'raw_name','Invalid second row',
          'amount','1.00',
          'amount_minor',999,
          'iso_currency_code','USD',
          'plaid_category','OTHER',
          'posted_date',current_date::text,
          'authorized_date',null,
          'pending',false,
          'retrieved_at',now(),
          'provider','plaid',
          'authority','provider',
          'generation_id','22345678-1234-4234-8234-1234567890ab'
        )
      )
    );
  `, { expectFailure: true, label: "invalid generation publication rollback" });
  assertScalar(
    "select generation_id::text || ':' || record_count::text || ':' || (select count(*)::text from fund_bank_transactions where plaid_transaction_id like 'rollback-%') from fund_provider_coverage where connection_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and component='transactions';",
    "12345678-1234-4234-8234-1234567890ab:5:0",
    "failed publication preserves prior rows and coverage",
  );
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,
      current_date,
      now(),
      '32345678-1234-4234-8234-1234567890ab',
      '[]'::jsonb
    );
  `, { label: "verified empty transaction generation publication" });
  assertScalar(
    "select generation_id::text || ':' || record_count::text || ':' || (generation_hash ~ '^[0-9a-f]{64}$')::text || ':' || (select count(*)::text from fund_bank_transactions where authority='provider') from fund_provider_coverage where connection_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and component='transactions';",
    "32345678-1234-4234-8234-1234567890ab:0:true:0",
    "exact verified-empty generation and reconciliation",
  );
  run(disposableUrl, `
    set role service_role;
    set request.jwt.claim.role = 'service_role';
    select * from public.publish_fund_transaction_generation(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      current_date - 90,
      current_date,
      now(),
      '32345678-1234-4234-8234-1234567890ab',
      jsonb_build_array(jsonb_build_object(
        'plaid_transaction_id','generation-rebind',
        'account_id','account-a',
        'merchant_name','Generation rebind',
        'raw_name','Generation rebind',
        'amount','1.00',
        'amount_minor',100,
        'iso_currency_code','USD',
        'plaid_category','OTHER',
        'posted_date',current_date::text,
        'authorized_date',null,
        'pending',false,
        'retrieved_at',now(),
        'provider','plaid',
        'authority','provider',
        'generation_id','32345678-1234-4234-8234-1234567890ab'
      ))
    );
  `, { expectFailure: true, label: "generation id fact rebind rollback" });
  assertScalar(
    "select record_count::text || ':' || (select count(*)::text from fund_bank_transactions where authority='provider') from fund_provider_coverage where connection_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and component='transactions';",
    "0:0",
    "generation rebind cannot mutate verified empty truth",
  );

  run(disposableUrl, `
    set role service_role;
    update public.integration_delivery_outbox
      set status='delivered', accepted_at=now(), delivered_at=now(), last_error_code=null
      where dedupe_key_hash=repeat('a',64);
  `, { label: "simulate verified delivery callback" });
  run(disposableUrl, migrationSql, { label: "reapply financial-truth migration" });
  assertScalar(
    "select status || ':' || (accepted_at is not null)::text || ':' || (delivered_at is not null)::text from integration_delivery_outbox;",
    "delivered:true:true",
    "verified delivery survives reapply",
  );

  console.log(`Financial-truth DB validation passed in disposable database ${databaseName}.`);
} finally {
  if (created) {
    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error("refusing to drop non-validator database");
    }
    run(
      baseUrl,
      `select pg_terminate_backend(pid) from pg_stat_activity where datname='${databaseName}' and pid <> pg_backend_pid(); drop database "${databaseName}";`,
      { label: "drop disposable database" },
    );
  }
}
