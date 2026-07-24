import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationFile = "supabase/migrations/20260723090000_net_worth_snapshots_authority_provenance.sql";
const migration = readFileSync(resolve(process.cwd(), migrationFile), "utf8");

describe("net-worth snapshot database authority contract", () => {
  it("permits only exact complete provider v2 USD truth or explicitly legacy/unknown rows", () => {
    expect(migration).toContain("net_worth_snapshots_authority_contract");
    expect(migration).toContain("calculation_version = 'financial-truth-v2'");
    expect(migration).toContain("calculation_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("input_as_of is not null");
    expect(migration).toContain("net_worth = cash + invested - liabilities");
    expect(migration).toContain("authority = 'legacy_unknown'");
    expect(migration).toContain("calculation_version = 'legacy_unknown'");
    expect(migration).toContain("net-worth snapshot revisions are append-only");
  });

  it("downgrades authenticated writes and blocks owner mutation of service-managed facts", () => {
    expect(migration).toContain("if current_user = 'authenticated' then");
    expect(migration).toContain("new.authority := 'legacy_unknown'");
    expect(migration).toContain("new.snapshot_status := 'legacy_unknown'");
    expect(migration).toContain("new.currency := null");
    expect(migration).toContain("new.calculation_version := 'legacy_unknown'");
    expect(migration).toMatch(/tg_op in \('UPDATE', 'DELETE'\) and old\.authority = 'provider'/);
    expect(migration).toContain("raise exception 'provider-authoritative net-worth snapshots are server-managed'");
    expect(migration).toMatch(/before insert or update or delete on public\.net_worth_snapshots/);
    expect(migration).toContain("provider bank transaction facts are immutable to owners");
    expect(migration).toContain("detected recurring facts are server-managed");
  });

  it("hardens the atomic publication RPC and binds the exact migration in the release manifest", () => {
    expect(migration).toContain("create or replace function public.publish_fund_transaction_generation");
    expect(migration).toMatch(
      /publish_fund_transaction_generation[\s\S]*?security definer[\s\S]*?set search_path = ''/,
    );
    expect(migration).toContain("owner to postgres");
    expect(migration).toContain("if (select auth.role()) is distinct from 'service_role' then");
    expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(migration).toContain("transaction generation id cannot be rebound to different facts");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain(
      "revoke all on function public.publish_fund_transaction_generation(uuid,uuid,date,date,timestamptz,uuid,jsonb)",
    );

    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), "scripts/release-migration-manifest.json"),
      "utf8",
    )) as { migrations: Array<{ version: string; file: string; sha256: string }> };
    const entry = manifest.migrations.find((candidate) => candidate.file === migrationFile);
    const sha256 = createHash("sha256").update(migration).digest("hex");
    expect(entry).toEqual({
      version: "20260723090000",
      file: migrationFile,
      sha256,
    });
  });
});
