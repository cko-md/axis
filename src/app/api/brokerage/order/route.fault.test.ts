import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST } from "./route";

describe("legacy order route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    });
  });

  it("is permanently retired and never returns an execution-shaped success", async () => {
    const response = await POST(new NextRequest("http://axis.test/api/brokerage/order", {
      method: "POST",
      body: JSON.stringify({ symbol: "AAPL", side: "buy", quantity: 1 }),
    }));

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "LEGACY_ORDER_ROUTE_RETIRED" }));
  });
});
