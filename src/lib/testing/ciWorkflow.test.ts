import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);

describe("authenticated CI database contract", () => {
  it("uses the exact allowlisted local Supabase origin for secret-free builds", () => {
    expect(workflow).not.toContain("https://placeholder.supabase.co");
    expect(
      workflow.match(
        /NEXT_PUBLIC_SUPABASE_URL: http:\/\/127\.0\.0\.1:54321/g,
      ),
    ).toHaveLength(3);
  });

  it("executes multi-statement SQL through psql instead of one prepared query", () => {
    expect(workflow).not.toContain(
      "supabase db query --local --file scripts/sql/bootstrap-local-e2e-role-grants.sql",
    );
    expect(workflow).not.toContain(
      "supabase db query --local --file scripts/sql/verify-20260716-contract.sql",
    );
    expect(workflow).toContain(
      "docker exec -i supabase_db_axis psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/bootstrap-local-e2e-role-grants.sql",
    );
    expect(workflow).toContain(
      "docker exec -i supabase_db_axis psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/verify-20260716-contract.sql",
    );
  });

  it("verifies the final privilege contract before provisioning browser auth", () => {
    const bootstrap = workflow.indexOf(
      "scripts/sql/bootstrap-local-e2e-role-grants.sql",
    );
    const verify = workflow.indexOf("scripts/sql/verify-20260716-contract.sql");
    const provision = workflow.indexOf("scripts/bootstrap-authenticated-e2e.mjs");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(bootstrap);
    expect(provision).toBeGreaterThan(verify);
  });
});
