import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationFile = "supabase/migrations/20260809210000_fund_order_intents_and_execution_receipts.sql";
const migration = readFileSync(resolve(process.cwd(), migrationFile), "utf8");

describe("order intent and verified execution database contract", () => {
  it("keeps immutable not-submitted intents distinct from fills", () => {
    expect(migration).toContain("create table if not exists public.fund_order_intents");
    expect(migration).toContain("unique (user_id, idempotency_key)");
    expect(migration).toContain("check (status = 'not_submitted')");
    expect(migration).toContain("payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$')");
    expect(migration).toContain("grant select on table public.fund_order_intents to authenticated");
    expect(migration).not.toContain("grant insert on table public.fund_order_intents to authenticated");
  });

  it("allows a provider execution only through a unique immutable fill receipt", () => {
    expect(migration).toContain("create table if not exists public.fund_execution_receipts");
    expect(migration).toContain("unique (provider, provider_account_ref_hash, provider_fill_id)");
    expect(migration).toContain("verified execution receipts are immutable");
    expect(migration).toContain("execution_authority = 'provider_verified'");
    expect(migration).toContain("execution_receipt_id is not null");
    expect(migration).toContain("execution does not match verified receipt");
    expect(migration).toContain("provider-verified executions are immutable");
    expect(migration).toContain("revoke insert, update, delete, truncate on table public.fund_transactions from authenticated");
  });

  it("exposes one service-only idempotent receipt materialization boundary", () => {
    expect(migration).toMatch(
      /record_verified_fund_execution[\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(migration).toContain("if auth.role() <> 'service_role' then");
    expect(migration).toContain("on conflict (provider, provider_account_ref_hash, provider_fill_id) do nothing");
    expect(migration).toContain("on conflict (execution_receipt_id) where execution_receipt_id is not null do nothing");
    expect(migration).toContain("grant execute on function public.record_verified_fund_execution");

    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), "scripts/release-migration-manifest.json"),
      "utf8",
    )) as { migrations: Array<{ version: string; file: string; sha256: string }> };
    const entry = manifest.migrations.find((candidate) => candidate.file === migrationFile);
    expect(entry).toEqual({
      version: "20260809210000",
      file: migrationFile,
      sha256: createHash("sha256").update(migration).digest("hex"),
    });
  });
});
