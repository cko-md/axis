import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = "supabase/migrations/20260809250000_financial_truth_contract_completion.sql";
const sql = readFileSync(resolve(process.cwd(), file), "utf8");

describe("financial truth contract-completion migration", () => {
  it("contracts connection credentials and mutations behind the server role", () => {
    expect(sql).toContain('drop policy if exists "fund_connections_insert_own"');
    expect(sql).toContain("revoke all on table public.fund_connections from authenticated");
    const grant = sql.match(/grant select \(([\s\S]*?)\) on table public\.fund_connections to authenticated;/)?.[1] ?? "";
    expect(grant).toContain("user_id");
    expect(grant).not.toContain("access_token_enc");
    expect(grant).not.toContain("refresh_token_enc");
    expect(grant).not.toContain("item_id");
  });

  it("binds cascade, one-Item, symbol, recurring, and cron continuation contracts", () => {
    expect(sql).toContain("pg_catalog.pg_trigger_depth() = 2");
    expect(sql).toContain("fund_connections_one_active_plaid_item_uidx");
    expect(sql).toContain("where provider = 'plaid' and status <> 'revoked'");
    expect(sql).toContain("fund_order_intents_symbol_contract");
    expect(sql).toContain("reconcile_fund_recurring_generation");
    expect(sql).toContain("and existing.source = 'detected'");
    expect(sql).toContain("set status = 'cancelled'");
    expect(sql).toContain("create table if not exists public.finance_cron_cursors");
    expect(sql).toContain("claim_finance_cron_connections");
    expect(sql).toContain("claim_finance_cron_users");
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("remains an exact append-only manifest entry", () => {
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), "scripts/release-migration-manifest.json"),
      "utf8",
    )) as { migrationCount: number; latest: { file: string; sha256: string }; migrations: Array<{ file: string; sha256: string }> };
    const digest = createHash("sha256").update(sql).digest("hex");
    expect(manifest.migrationCount).toBe(98);
    expect(manifest.migrations.find((entry) => entry.file === file)?.sha256).toBe(digest);
  });
});
