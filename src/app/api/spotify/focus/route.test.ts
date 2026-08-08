import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getAccessToken: vi.fn(),
  spotifyGet: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("../_lib", () => ({
  getAccessToken: mocks.getAccessToken,
  notConnected: () => new Response(JSON.stringify({ connected: false }), { status: 401 }),
  spotifyFetch: vi.fn(),
  spotifyGet: mocks.spotifyGet,
  toTrackLite: (track: unknown) => track,
}));

import { POST } from "./route";

describe("Spotify focus internal AI topology", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } } }) } });
    mocks.getAccessToken.mockResolvedValue("token");
    mocks.spotifyGet.mockResolvedValue({ tracks: { items: [] } });
  });

  it("does not self-fetch an attacker-controlled Host when deriving a focus label", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await POST(new Request("https://attacker.invalid/api/spotify/focus", {
        method: "POST",
        headers: {
          host: "attacker.invalid",
          cookie: "session=must-not-forward",
          [EXPECTED_PROFILE_SUBJECT_HEADER]: profileSubjectForUserId("user"),
        },
        body: JSON.stringify({ prompt: "deep work" }),
      }));

      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.spotifyGet).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
