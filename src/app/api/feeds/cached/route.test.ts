import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  fetchAndParse: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/feeds/rss", () => ({ fetchAndParse: mocks.fetchAndParse }));
vi.mock("@sentry/nextjs", () => ({ addBreadcrumb: mocks.addBreadcrumb, captureException: mocks.captureException }));

import { SafeFetchError } from "@/lib/security/safe-fetch";
import { POST } from "./route";

describe("cached feed route", () => {
  it("delegates a missing cache canary to shared safe fetch and marks the source failed", async () => {
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) },
      from: vi.fn(() => ({ select: vi.fn(() => ({ in: vi.fn().mockResolvedValue({ data: [] }) })) })),
    });
    mocks.fetchAndParse.mockRejectedValue(new SafeFetchError("SAFE_FETCH_BLOCKED_ADDRESS"));

    const response = await POST(new Request("http://axis.test/api/feeds/cached", {
      method: "POST",
      body: JSON.stringify({ feedUrls: ["http://[::ffff:127.0.0.1]/canary?body=never"] }),
    }) as never);
    const body = await response.json();

    expect(mocks.fetchAndParse).toHaveBeenCalledWith("http://[::ffff:127.0.0.1]/canary?body=never");
    expect(body).toMatchObject({
      items: [], partial: true,
      sources: [{ host: "[::ffff:7f00:1]", state: "failed", code: "SAFE_FETCH_BLOCKED_ADDRESS" }],
    });
    expect(JSON.stringify(mocks.addBreadcrumb.mock.calls)).not.toContain("body=never");
  });
});
