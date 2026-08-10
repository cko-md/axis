import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { DELETE as deleteHolding } from "./holdings/[id]/route";
import { DELETE as deleteLiability, PATCH as patchLiability } from "./liabilities/[id]/route";
import { POST as readBudget } from "../plaid/budget/route";
import { POST as readTransactions } from "../plaid/transactions/route";

const STALE_SUBJECT = `ps1_${"f".repeat(64)}`;

function request(path: string, method = "POST") {
  return new NextRequest(`http://axis.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-axis-expected-profile-subject": STALE_SUBJECT,
    },
    body: method === "PATCH" ? JSON.stringify({ balance: "1.00" }) : undefined,
  });
}

describe("financial mutation subject boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        })),
      },
      from: vi.fn(() => {
        throw new Error("financial storage must not be reached after a subject mismatch");
      }),
    });
  });

  it.each([
    ["delete holding", () => deleteHolding(request("/api/fund/holdings/holding-1", "DELETE"), { params: Promise.resolve({ id: "holding-1" }) })],
    ["patch liability", () => patchLiability(request("/api/fund/liabilities/liability-1", "PATCH"), { params: Promise.resolve({ id: "liability-1" }) })],
    ["delete liability", () => deleteLiability(request("/api/fund/liabilities/liability-1", "DELETE"), { params: Promise.resolve({ id: "liability-1" }) })],
    ["read budget", () => readBudget(request("/api/plaid/budget"))],
    ["read transaction card", () => readTransactions(request("/api/plaid/transactions"))],
  ])("rejects stale authority before attempting to %s", async (_label, execute) => {
    const response = await execute();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "SUBJECT_CHANGED" });
  });
});
