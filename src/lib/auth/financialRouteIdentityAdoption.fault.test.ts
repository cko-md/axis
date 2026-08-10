import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const protectedFinancialRoutes = [
  "src/app/api/fund/advisor/route.ts",
  "src/app/api/fund/bank-transactions/[id]/route.ts",
  "src/app/api/fund/category-budgets/[id]/route.ts",
  "src/app/api/fund/category-budgets/route.ts",
  "src/app/api/fund/holdings/[id]/route.ts",
  "src/app/api/fund/holdings/route.ts",
  "src/app/api/fund/insights/route.ts",
  "src/app/api/fund/liabilities/[id]/route.ts",
  "src/app/api/fund/liabilities/route.ts",
  "src/app/api/fund/networth/route.ts",
  "src/app/api/fund/position/[symbol]/route.ts",
  "src/app/api/fund/recurring/[id]/route.ts",
  "src/app/api/fund/recurring/route.ts",
  "src/app/api/fund/report/route.ts",
  "src/app/api/brokerage/accounts/route.ts",
  "src/app/api/brokerage/order-history/route.ts",
  "src/app/api/brokerage/positions/route.ts",
] as const;

describe("financial route authentication observability adoption", () => {
  it.each(protectedFinancialRoutes)("uses the shared expected-versus-operational boundary in %s", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).toContain("resolveRouteIdentity");
    expect(source).not.toContain("auth.getUser()");
  });
});
