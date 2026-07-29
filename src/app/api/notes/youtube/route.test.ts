import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  safeFetch: vi.fn(),
  recordSafeFetchFailure: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/security/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("@/lib/security/safe-fetch-observability", () => ({ recordSafeFetchFailure: mocks.recordSafeFetchFailure }));

import { POST } from "./route";

describe("YouTube caption safe-fetch boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) },
    });
  });

  it("rejects an HTTP caption URL derived from watch-page HTML before it can be fetched", async () => {
    const player = {
      videoDetails: { title: "Safe video" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "http://127.0.0.1/internal?token=never" }] } },
    };
    mocks.safeFetch.mockResolvedValueOnce(new Response(`ytInitialPlayerResponse = ${JSON.stringify(player)};`));

    const response = await POST(new Request("https://axis.test/api/notes/youtube", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    }) as never);

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("token=never");
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
    expect(String(mocks.safeFetch.mock.calls[0]?.[0])).toContain("www.youtube.com/watch");
    expect(JSON.stringify(mocks.safeFetch.mock.calls)).not.toContain("127.0.0.1");
    expect(mocks.recordSafeFetchFailure).toHaveBeenCalledWith("youtube_caption", expect.any(String), expect.any(Error));
  });
});
