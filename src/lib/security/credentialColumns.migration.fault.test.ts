import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(
    root,
    "supabase/migrations/20260723235900_credential_column_lockdown.sql",
  ),
  "utf8",
);
const bootstrap = readFileSync(
  join(root, "scripts/sql/bootstrap-local-e2e-role-grants.sql"),
  "utf8",
);
const verifier = readFileSync(
  join(root, "scripts/sql/verify-20260723-credential-contract.sql"),
  "utf8",
);

describe("credential column migration contract", () => {
  it("removes browser fund-connection mutations and grants only safe display columns", () => {
    expect(migration).toContain(
      'drop policy if exists "fund_connections_insert_own"',
    );
    expect(migration).toContain(
      'drop policy if exists "fund_connections_update_own"',
    );
    expect(migration).toContain(
      'drop policy if exists "fund_connections_delete_own"',
    );
    expect(migration).toContain(
      "revoke all privileges on table public.fund_connections from anon, authenticated",
    );

    const safeGrant = migration.match(
      /grant select \(([\s\S]*?)\) on table public\.fund_connections to authenticated;/,
    )?.[1] ?? "";
    expect(safeGrant).toContain("institution");
    expect(safeGrant).toContain("status");
    expect(safeGrant).not.toContain("item_id");
    expect(safeGrant).not.toContain("access_token_enc");
    expect(safeGrant).not.toContain("refresh_token_enc");
  });

  it("keeps the legacy passkey ciphertext out of authenticated projections", () => {
    const passkeySection = migration.slice(
      migration.indexOf(
        "revoke all privileges on table public.user_passkeys",
      ),
    );
    const safeGrant = passkeySection.match(
      /grant select \(([\s\S]*?)\) on table public\.user_passkeys to authenticated;/,
    )?.[1] ?? "";
    expect(safeGrant).toContain("credential_id");
    expect(safeGrant).toContain("name");
    expect(safeGrant).not.toContain("refresh_token_enc");
  });

  it("reasserts both column boundaries after local grant derivation", () => {
    expect(bootstrap).toContain(
      "revoke all privileges on public.fund_connections from anon, authenticated",
    );
    expect(bootstrap).toContain(
      "revoke all privileges on public.user_passkeys from anon, authenticated",
    );
    expect(verifier).toContain(
      "'authenticated',\n      'public.fund_connections',\n      'access_token_enc'",
    );
    expect(verifier).toContain(
      "perform refresh_token_enc from public.user_passkeys",
    );
    expect(verifier).toContain("set local role service_role");
  });
});
