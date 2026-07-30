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

describe("briefing feed fetch route", () => {
  it("delegates the internal canary to the shared boundary and reports an honest partial source failure", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) } });
    mocks.fetchAndParse.mockRejectedValue(new SafeFetchError("SAFE_FETCH_BLOCKED_ADDRESS"));

    const response = await POST(new Request("http://axis.test/api/briefing/fetch-feeds", {
      method: "POST",
      body: JSON.stringify({ feedUrls: ["http://[::ffff:127.0.0.1]/canary?token=never"] }),
    }) as never);
    const body = await response.json();

    expect(mocks.fetchAndParse).toHaveBeenCalledWith("http://[::ffff:127.0.0.1]/canary?token=never");
    expect(body).toMatchObject({
      items: [], partial: true,
      sources: [{ host: "[::ffff:7f00:1]", state: "failed", code: "SAFE_FETCH_BLOCKED_ADDRESS" }],
    });
    expect(JSON.stringify(mocks.addBreadcrumb.mock.calls)).not.toContain("token=never");
  });

  it("coalesces six operational failures into one safe Sentry event while retaining each source code", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) } });
    mocks.fetchAndParse.mockRejectedValue(new SafeFetchError("SAFE_FETCH_TIMEOUT"));
    const feedUrls = Array.from({ length: 6 }, (_, index) => `https://feed-${index}.example/private?token=must-not-leak`);

    const response = await POST(new Request("http://axis.test/api/briefing/fetch-feeds", { method: "POST", body: JSON.stringify({ feedUrls }) }) as never);
    const body = await response.json();

    expect(body.sources).toHaveLength(6);
    expect(body.sources.every((source: { state: string; code: string }) => source.state === "failed" && source.code === "SAFE_FETCH_TIMEOUT")).toBe(true);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("feed-0.example");
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("must-not-leak");
  });
});
