import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const baseUrl = new URL(
  process.env.AXIS_FINANCE_CRON_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
if (!["127.0.0.1", "localhost"].includes(baseUrl.hostname)) {
  throw new Error("finance cron lease validation is restricted to local PostgreSQL");
}
if (decodeURIComponent(baseUrl.pathname) !== "/postgres") {
  throw new Error("finance cron lease validator base URL must target postgres");
}

const binDir = process.env.PSQL_BIN_DIR ?? "/opt/homebrew/opt/libpq/bin";
const psql = resolve(binDir, "psql");
for (const binary of [psql]) {
  if (!existsSync(binary)) throw new Error(`required PostgreSQL binary missing: ${binary}`);
}

const disposableUrl = baseUrl;

function sql(url, source, { expectFailure = false } = {}) {
  const result = spawnSync(psql, [url.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], {
    input: source,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 4000);
    throw new Error(`SQL probe ${expectFailure ? "unexpectedly succeeded" : "failed"}${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

function expectOutput(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

try {
  sql(
    disposableUrl,
    readFileSync(resolve(root, "supabase/migrations/20260809260000_finance_contract_and_cron_lease.sql"), "utf8"),
  );

  sql(disposableUrl, `
    insert into auth.users(id, email, aud, role, created_at, updated_at)
    values ('96000000-0000-4000-8000-000000000001', 'axis-cron-lease@example.invalid', 'authenticated', 'authenticated', now(), now());
    insert into public.fund_connections(
      id, user_id, provider, item_id, institution, status,
      access_token_enc, authority, verified_at
    ) values (
      '96000000-0000-4000-8000-000000000002',
      '96000000-0000-4000-8000-000000000001',
      'plaid', 'cron-lease-item', 'Synthetic', 'linked',
      'synthetic-ciphertext', 'provider_verified', now()
    );
  `);

  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.acquire_finance_cron_run('96000000-0000-4000-8000-000000000010', 120);
  `), "t", "first run acquires lease");
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select count(*) from public.claim_finance_cron_connections(
      '96000000-0000-4000-8000-000000000010', 100
    ) where id='96000000-0000-4000-8000-000000000002';
  `), "1", "lease owner claims work");

  // A distinct psql process is a distinct database session. It must neither
  // acquire the live lease nor acknowledge work owned by the first token.
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.acquire_finance_cron_run('96000000-0000-4000-8000-000000000011', 120);
  `), "f", "overlapping session is excluded");
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.ack_finance_cron_connection(
      '96000000-0000-4000-8000-000000000011',
      '96000000-0000-4000-8000-000000000002'
    );
  `), "f", "foreign token cannot acknowledge work");

  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.ack_finance_cron_connection(
      '96000000-0000-4000-8000-000000000010',
      '96000000-0000-4000-8000-000000000002'
    );
  `), "t", "owner token acknowledges work");
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.release_finance_cron_run('96000000-0000-4000-8000-000000000010');
  `), "t", "owner token releases lease");
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.acquire_finance_cron_run('96000000-0000-4000-8000-000000000011', 120);
  `), "t", "next run acquires released lease");
  sql(disposableUrl, "update public.finance_cron_run_leases set lease_expires_at=now()-interval '1 second';");
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.acquire_finance_cron_run('96000000-0000-4000-8000-000000000012', 120);
  `), "t", "expired run is reclaimed");

  // Browser execution DML and lineage-less detected facts fail closed.
  sql(disposableUrl, `
    set role authenticated;
    set request.jwt.claim.sub='96000000-0000-4000-8000-000000000001';
    insert into public.fund_transactions(user_id, symbol, kind, shares, price, amount, currency)
    values ('96000000-0000-4000-8000-000000000001','AAPL','buy',1,1,1,'USD');
  `, { expectFailure: true });
  sql(disposableUrl, `
    insert into public.fund_recurring_transactions(
      user_id, merchant_name, expected_amount, currency, cadence, source, status
    ) values (
      '96000000-0000-4000-8000-000000000001','Unproved',1,'USD','monthly','detected','active'
    );
  `, { expectFailure: true });
  expectOutput(sql(disposableUrl, `
    insert into public.fund_recurring_transactions(
      user_id, merchant_name, expected_amount, currency, cadence, source, status
    ) values
      ('96000000-0000-4000-8000-000000000001','Synthetic Merchant',10,'USD','monthly','manual','active'),
      ('96000000-0000-4000-8000-000000000001','Synthetic Merchant',9,'EUR','monthly','manual','active');
    select count(*) from public.fund_recurring_transactions
      where user_id='96000000-0000-4000-8000-000000000001'
        and merchant_name='Synthetic Merchant';
  `), "2", "multi-currency recurring identities coexist");

  console.log("FINANCE_CRON_LEASE_DB_PASS");
} finally {
  sql(baseUrl, `
    delete from public.finance_cron_run_claims
      where run_id in (
        '96000000-0000-4000-8000-000000000010',
        '96000000-0000-4000-8000-000000000011',
        '96000000-0000-4000-8000-000000000012'
      );
    delete from public.finance_cron_run_leases
      where run_id in (
        '96000000-0000-4000-8000-000000000010',
        '96000000-0000-4000-8000-000000000011',
        '96000000-0000-4000-8000-000000000012'
      );
    delete from auth.users where id='96000000-0000-4000-8000-000000000001';
    update public.finance_cron_cursors
      set last_connection_id=null
      where job_key='finance-daily-plaid-sync'
        and last_connection_id='96000000-0000-4000-8000-000000000002';
  `);
}
