import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { GET } from "./route";

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("fund insights subject boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })) },
      from: vi.fn(() => { throw new Error("must not query after subject mismatch"); }),
    });
  });

  it("returns 409 before reading another subject's persisted brief", async () => {
    const response = await GET(new NextRequest("http://axis.test/api/fund/insights?kind=daily_brief", {
      headers: { "x-axis-expected-profile-subject": `ps1_${"f".repeat(64)}` },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "SUBJECT_CHANGED" });
  });
});
