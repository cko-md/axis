import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260809220000_financial_truth_expansion_privilege_repair.sql",
  ),
  "utf8",
);

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
] as const;

describe("financial-truth privilege repair migration", () => {
  it("revokes anonymous privileges across every financial expansion table", () => {
    for (const table of financialTables) {
      expect(migration).toMatch(new RegExp(`\\bpublic\\.${table}\\b`));
    }
    expect(migration).toMatch(/revoke all on table[\s\S]*from public, anon;/);
  });

  it("makes the exact view security-invoker and select-only", () => {
    expect(migration).toContain("set (security_invoker = true, security_barrier = true)");
    expect(migration).toContain(
      "revoke all on table public.net_worth_snapshots_exact\n  from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "grant select on table public.net_worth_snapshots_exact\n  to authenticated, service_role;",
    );
  });

  it("is transaction wrapped", () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nbegin;/);
    expect(migration.trimEnd()).toMatch(/commit;$/);
  });
});
