import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { PATCH } from "./route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://axis.test/api/fund/category-budgets/budget-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function client(existing: { currency: string } | null) {
  const updates: Record<string, unknown>[] = [];
  const from = vi.fn(() => ({
    select: vi.fn(() => {
      const chain = {
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({ data: existing, error: null })),
      };
      return chain;
    }),
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      const chain = {
        eq: vi.fn(() => chain),
        select: vi.fn(() => chain),
        single: vi.fn(async () => ({ data: { id: "budget-1", ...payload }, error: null })),
      };
      return chain;
    }),
  }));
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    from,
    updates,
  };
}

describe("category budget currency authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains the owned row currency when PATCH omits currency", async () => {
    const supabase = client({ currency: "EUR" });
    mocks.createClient.mockResolvedValue(supabase);

    const response = await PATCH(request({ monthly_limit: "12.34" }), {
      params: Promise.resolve({ id: "budget-1" }),
    });

    expect(response?.status).toBe(200);
    expect(supabase.updates[0]).toMatchObject({ monthly_limit: "12.34", currency: "EUR" });
  });

  it("rejects an invalid explicit currency", async () => {
    const supabase = client({ currency: "EUR" });
    mocks.createClient.mockResolvedValue(supabase);

    const response = await PATCH(request({ monthly_limit: "12.34", currency: "USX" }), {
      params: Promise.resolve({ id: "budget-1" }),
    });

    expect(response?.status).toBe(400);
    expect(supabase.updates).toHaveLength(0);
  });

  it("returns not found when an omitted currency cannot be loaded from an owned row", async () => {
    mocks.createClient.mockResolvedValue(client(null));

    const response = await PATCH(request({ monthly_limit: "12.34" }), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response?.status).toBe(404);
  });
});
