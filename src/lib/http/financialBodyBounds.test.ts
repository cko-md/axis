import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = [
  "src/app/api/brokerage/order/route.ts",
  "src/app/api/brokerage/orders/route.ts",
  "src/app/api/fund/advisor/route.ts",
  "src/app/api/fund/bank-transactions/[id]/route.ts",
  "src/app/api/fund/category-budgets/route.ts",
  "src/app/api/fund/category-budgets/[id]/route.ts",
  "src/app/api/fund/holdings/route.ts",
  "src/app/api/fund/liabilities/route.ts",
  "src/app/api/fund/liabilities/[id]/route.ts",
  "src/app/api/fund/recurring/[id]/route.ts",
] as const;

describe("financial mutation body bounds", () => {
  it("does not use unbounded Request.json parsing", () => {
    for (const route of ROUTES) {
      const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
      expect(source, route).not.toMatch(/\b(?:request|req)\.json\s*\(/);
    }
  });
});
