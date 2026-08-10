import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260809260000_finance_contract_and_cron_lease.sql"),
  "utf8",
).toLowerCase();
const file = "supabase/migrations/20260809260000_finance_contract_and_cron_lease.sql";

describe("finance contract and durable cron lease migration", () => {
  it("removes browser execution DML and the obsolete recurring arbiter", () => {
    expect(sql).toContain('drop policy if exists "fund_transactions_insert_own"');
    expect(sql).toContain("revoke insert, update, delete, truncate on table public.fund_transactions");
    expect(sql).toContain("drop constraint if exists fund_recurring_transactions_user_merchant_uniq");
    expect(sql).toContain("fund_recurring_transactions_identity_uidx");
    expect(sql).toContain("detected recurring lineage is required");
    expect(sql).not.toContain("expansion compatibility: protected main writes detected rows");
  });

  it("requires a token-bound live lease for claims and acknowledgements", () => {
    expect(sql).toContain("acquire_finance_cron_run");
    expect(sql).toContain("finance_cron_run_leases");
    expect(sql).toContain("lease.run_id = p_run_id");
    expect(sql).toContain("lease.lease_expires_at > pg_catalog.now()");
    expect(sql).toContain("ack_finance_cron_connection");
    expect(sql).toContain("ack_finance_cron_user");
    expect(sql).toContain("release_finance_cron_run");
    expect(sql).toContain("revoke execute on function public.claim_finance_cron_connections(integer) from service_role");
  });

  it("advances cursors only in token-bound acknowledgement functions", () => {
    const connectionClaim = sql.slice(
      sql.indexOf("create or replace function public.claim_finance_cron_connections("),
      sql.indexOf("create or replace function public.ack_finance_cron_connection("),
    );
    const userClaim = sql.slice(
      sql.indexOf("create or replace function public.claim_finance_cron_users("),
      sql.indexOf("create or replace function public.ack_finance_cron_user("),
    );
    expect(connectionClaim).not.toContain("set last_connection_id = p_");
    expect(userClaim).not.toContain("set last_user_id = p_");
    expect(sql).toContain("set last_connection_id = p_connection_id");
    expect(sql).toContain("set last_user_id = p_user_id");
  });

  it("is the exact latest append-only manifest entry", () => {
    const raw = readFileSync(resolve(process.cwd(), file), "utf8");
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), "scripts/release-migration-manifest.json"),
      "utf8",
    )) as { migrationCount: number; latest: { version: string; file: string; sha256: string } };
    expect(manifest.migrationCount).toBe(98);
    expect(manifest.latest).toEqual({
      version: "20260809260000",
      file,
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
  });
});
