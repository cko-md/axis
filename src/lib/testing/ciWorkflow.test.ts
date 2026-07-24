import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);

describe("authenticated CI database contract", () => {
  it("executes multi-statement SQL through psql instead of one prepared query", () => {
    expect(workflow).not.toContain(
      "supabase db query --local --file scripts/sql/bootstrap-local-e2e-role-grants.sql",
    );
    expect(workflow).not.toContain(
      "supabase db query --local --file scripts/sql/verify-20260716-contract.sql",
    );
    expect(workflow).not.toContain(
      "supabase db query --local --file scripts/sql/verify-20260723-credential-contract.sql",
    );
    expect(workflow).toContain(
      "docker exec -i supabase_db_axis psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/bootstrap-local-e2e-role-grants.sql",
    );
    expect(workflow).toContain(
      "docker exec -i supabase_db_axis psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/verify-20260716-contract.sql",
    );
    expect(workflow).toContain(
      "docker exec -i supabase_db_axis psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/verify-20260723-credential-contract.sql",
    );
  });

  it("verifies the final privilege contract before provisioning browser auth", () => {
    const bootstrap = workflow.indexOf(
      "scripts/sql/bootstrap-local-e2e-role-grants.sql",
    );
    const verify = workflow.indexOf("scripts/sql/verify-20260716-contract.sql");
    const credentialVerify = workflow.indexOf(
      "scripts/sql/verify-20260723-credential-contract.sql",
    );
    const provision = workflow.indexOf("scripts/bootstrap-authenticated-e2e.mjs");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(bootstrap);
    expect(credentialVerify).toBeGreaterThan(verify);
    expect(provision).toBeGreaterThan(credentialVerify);
  });
});
