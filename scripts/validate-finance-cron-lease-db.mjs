import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sqlAsync(url, source) {
  const child = spawn(psql, [url.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(source);
  return new Promise((resolveProcess) => {
    child.on("close", (status) => resolveProcess({
      status,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }));
  });
}

async function waitForActivity(marker, waitEventType) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const count = sql(disposableUrl, `
      select count(*) from pg_catalog.pg_stat_activity
      where query like '%${marker}%'
        and wait_event_type='${waitEventType}';
    `);
    if (count === "1") return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${marker} ${waitEventType} activity`);
}

async function fencedExpiryProbe({ phase, operation, oldRun, newRun, itemId }) {
  const cursorKey = phase === "connections" ? "finance-daily-plaid-sync" : "finance-daily-user-jobs";
  const marker = `AXIS_STALE_${phase.toUpperCase()}_${operation.toUpperCase()}`;
  const blockerMarker = `${marker}_BLOCKER`;
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.acquire_finance_cron_run('${oldRun}', 120);
  `), "t", `${marker} old run acquires lease`);

  if (operation === "ack") {
    const claimFunction = phase === "connections"
      ? `select count(*) from public.claim_finance_cron_connections('${oldRun}', 100) where id='${itemId}'`
      : `select count(*) from public.claim_finance_cron_users('${oldRun}', 250) where user_id='${itemId}'`;
    expectOutput(sql(disposableUrl, `set role service_role; ${claimFunction};`), "1", `${marker} creates token-bound claim`);
  }
  const blocker = sqlAsync(disposableUrl, `
    begin;
    select 1 from public.finance_cron_cursors where job_key='${cursorKey}' for update;
    /* ${blockerMarker} */ select pg_catalog.pg_sleep(2.0);
    commit;
  `);
  await waitForActivity(blockerMarker, "Timeout");
  sql(disposableUrl, `
    update public.finance_cron_run_leases
    set lease_expires_at=pg_catalog.clock_timestamp()+interval '400 milliseconds'
    where run_id='${oldRun}';
  `);
  const statement = operation === "claim"
    ? phase === "connections"
      ? `select count(*) from public.claim_finance_cron_connections('${oldRun}', 100)`
      : `select count(*) from public.claim_finance_cron_users('${oldRun}', 250)`
    : phase === "connections"
      ? `select public.ack_finance_cron_connection('${oldRun}', '${itemId}')`
      : `select public.ack_finance_cron_user('${oldRun}', '${itemId}')`;
  const stale = sqlAsync(disposableUrl, `set role service_role; /* ${marker} */ ${statement};`);
  await waitForActivity(marker, "Lock");
  await delay(500);
  const successor = sqlAsync(disposableUrl, `
    set role service_role;
    select public.acquire_finance_cron_run('${newRun}', 120);
  `);
  const [blockerResult, staleResult, successorResult] = await Promise.all([blocker, stale, successor]);
  if (blockerResult.status !== 0) throw new Error(`${marker} blocker failed: ${blockerResult.stderr}`);
  if (operation === "claim") {
    if (staleResult.status === 0) throw new Error(`${marker} stale claim unexpectedly succeeded: ${staleResult.stdout}`);
  } else {
    if (staleResult.status !== 0 || staleResult.stdout !== "f") {
      throw new Error(`${marker} stale ack must return false: ${staleResult.stderr || staleResult.stdout}`);
    }
  }
  if (successorResult.status !== 0 || successorResult.stdout !== "t") {
    throw new Error(`${marker} successor takeover failed: ${successorResult.stderr || successorResult.stdout}`);
  }
  expectOutput(sql(disposableUrl, `
    select count(*) from public.finance_cron_run_claims
    where run_id='${oldRun}';
  `), "0", `${marker} leaves no stale claims`);
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.release_finance_cron_run('${newRun}');
  `), "t", `${marker} successor releases lease`);
}

async function main() {
try {
  sql(
    disposableUrl,
    readFileSync(resolve(root, "supabase/migrations/20260809260000_finance_contract_and_cron_lease.sql"), "utf8"),
  );
  sql(
    disposableUrl,
    readFileSync(resolve(root, "supabase/migrations/20260809270000_finance_cron_failure_isolation.sql"), "utf8"),
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

  // Direct service-role cursor mutation is retired; only fenced RPCs may move it.
  sql(disposableUrl, `
    set role service_role;
    update public.finance_cron_cursors set last_connection_id=null
    where job_key='finance-daily-plaid-sync';
  `, { expectFailure: true });

  // Consecutive failures back off twice, then become a visible quarantine.
  expectOutput(sql(disposableUrl, `
    set role service_role;
    select public.release_finance_cron_run('96000000-0000-4000-8000-000000000012');
  `), "t", "release normal-path lease before failure probes");
  for (const [runId, expected] of [
    ["96000000-0000-4000-8000-000000000030", "retry_scheduled"],
    ["96000000-0000-4000-8000-000000000031", "retry_scheduled"],
    ["96000000-0000-4000-8000-000000000032", "quarantined"],
  ]) {
    expectOutput(sql(disposableUrl, `
      set role service_role;
      select public.acquire_finance_cron_run('${runId}', 120);
    `), "t", `${expected} run acquires lease`);
    sql(disposableUrl, `
      update public.finance_cron_item_failures
      set next_attempt_at=pg_catalog.clock_timestamp()-interval '1 second'
      where phase='connections' and item_id='96000000-0000-4000-8000-000000000002';
    `);
    expectOutput(sql(disposableUrl, `
      set role service_role;
      select count(*) from public.claim_finance_cron_connections('${runId}', 100)
      where id='96000000-0000-4000-8000-000000000002';
    `), "1", `${expected} run reclaims due item`);
    expectOutput(sql(disposableUrl, `
      set role service_role;
      select public.fail_finance_cron_item(
        '${runId}', 'connections',
        '96000000-0000-4000-8000-000000000002', 'SYNTHETIC_FAILURE'
      );
    `), expected, `${expected} disposition is durable`);
    expectOutput(sql(disposableUrl, `
      set role service_role;
      select public.release_finance_cron_run('${runId}');
    `), "t", `${expected} run releases lease`);
  }
  expectOutput(sql(disposableUrl, `
    select attempt_count || ':' || (quarantined_at is not null)::text
    from public.finance_cron_item_failures
    where phase='connections' and item_id='96000000-0000-4000-8000-000000000002';
  `), "3:true", "third failure is quarantined");
  sql(disposableUrl, `
    delete from public.finance_cron_item_failures
    where phase='connections' and item_id='96000000-0000-4000-8000-000000000002';
    update public.finance_cron_cursors set last_connection_id=null, last_user_id=null;
  `);

  // Parallel sessions force each claim/ack to block beyond lease expiry.
  // The stale token must neither return work nor mutate cursor/claim state,
  // while the successor remains serialized on the exact lease row.
  await fencedExpiryProbe({
    phase: "connections", operation: "claim",
    oldRun: "96000000-0000-4000-8000-000000000040",
    newRun: "96000000-0000-4000-8000-000000000041",
    itemId: "96000000-0000-4000-8000-000000000002",
  });
  await fencedExpiryProbe({
    phase: "connections", operation: "ack",
    oldRun: "96000000-0000-4000-8000-000000000042",
    newRun: "96000000-0000-4000-8000-000000000043",
    itemId: "96000000-0000-4000-8000-000000000002",
  });
  await fencedExpiryProbe({
    phase: "users", operation: "claim",
    oldRun: "96000000-0000-4000-8000-000000000044",
    newRun: "96000000-0000-4000-8000-000000000045",
    itemId: "96000000-0000-4000-8000-000000000001",
  });
  await fencedExpiryProbe({
    phase: "users", operation: "ack",
    oldRun: "96000000-0000-4000-8000-000000000046",
    newRun: "96000000-0000-4000-8000-000000000047",
    itemId: "96000000-0000-4000-8000-000000000001",
  });

  console.log("FINANCE_CRON_LEASE_DB_PASS");
} finally {
  sql(baseUrl, `
    delete from public.finance_cron_run_claims
      where run_id::text like '96000000-0000-4000-8000-0000000000%';
    delete from public.finance_cron_run_leases
      where run_id::text like '96000000-0000-4000-8000-0000000000%';
    delete from public.finance_cron_item_failures
      where item_id in (
        '96000000-0000-4000-8000-000000000001',
        '96000000-0000-4000-8000-000000000002'
      );
    delete from auth.users where id='96000000-0000-4000-8000-000000000001';
    update public.finance_cron_cursors
      set last_connection_id=null
      where job_key='finance-daily-plaid-sync'
        and last_connection_id='96000000-0000-4000-8000-000000000002';
  `);
}
}

await main();
