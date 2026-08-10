import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationFile = "supabase/migrations/20260809280000_financial_truth_strict_contract.sql";
const migration = readFileSync(resolve(process.cwd(), migrationFile), "utf8");

describe("financial-truth strict post-application contract", () => {
  it("removes expansion writers and quarantines lineage-less detected facts", () => {
    expect(migration).toContain("drop trigger if exists guard_fund_connection_expansion_compatibility");
    expect(migration).toContain("drop trigger if exists guard_make_outbox_expansion_compatibility");
    expect(migration).toContain("create table if not exists public.fund_recurring_lineage_quarantine");
    expect(migration).toContain("pg_catalog.to_jsonb(recurring)");
    expect(migration).toContain("delete from public.fund_recurring_transactions recurring");
    expect(migration).toContain("lineage-less detected recurring rows remain after quarantine");
    expect(migration).not.toContain("repeat('0', 64)");
  });

  it("requires non-empty authoritative lineage for every detected recurring fact", () => {
    expect(migration).toContain("fund_recurring_transactions_lineage_contract");
    expect(migration).toContain("source_generations is not null");
    expect(migration).toContain("source_generation_hash is not null");
    expect(migration).toContain("pg_catalog.jsonb_array_length(source_generations) > 0");
    expect(migration).toContain("source_generation_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("raise exception 'detected recurring lineage is required'");
    expect(migration).toContain("raise exception 'detected recurring lineage is not current and complete'");
    expect(migration).toContain("new.source_generations is distinct from coverage_lineage");
  });

  it("retires legacy arbiters and preserves browser read-only boundaries", () => {
    for (const constraint of [
      "fund_category_budgets_user_id_category_key",
      "fund_bank_transactions_user_id_plaid_transaction_id_key",
      "fund_recurring_transactions_user_merchant_uniq",
      "fund_holdings_user_id_symbol_key",
    ]) {
      expect(migration).toContain(`drop constraint if exists ${constraint}`);
    }
    expect(migration).toContain("revoke all on table public.fund_connections from authenticated");
    expect(migration).toContain("revoke all on table public.fund_transactions from authenticated, service_role");
    expect(migration).toContain("grant select on table public.fund_transactions to authenticated, service_role");
  });

  it("is exactly bound as the latest release migration", () => {
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), "scripts/release-migration-manifest.json"),
      "utf8",
    )) as {
      migrationCount: number;
      latest: { version: string; file: string; sha256: string };
      migrations: Array<{ version: string; file: string; sha256: string }>;
    };
    const expected = {
      version: "20260809280000",
      file: migrationFile,
      sha256: createHash("sha256").update(migration).digest("hex"),
    };
    expect(manifest.migrationCount).toBe(100);
    expect(manifest.latest).toEqual(expected);
    expect(manifest.migrations.find((candidate) => candidate.file === migrationFile)).toEqual(expected);
  });
});
