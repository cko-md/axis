import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getAccessToken: vi.fn(),
  stravaGet: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/app/api/strava/_lib", () => ({
  getAccessToken: mocks.getAccessToken,
  stravaGet: mocks.stravaGet,
  metresToKm: (metres: number) => Math.round(metres / 100) / 10,
}));
vi.mock("@/lib/observability/providerTiming", () => ({ logRouteTiming: vi.fn() }));

import { GET } from "./route";

describe("AUTH-006 training widget identity boundary", () => {
  const userId = "training-user";
  const subject = profileSubjectForUserId(userId);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: userId } },
          error: null,
        }),
      },
    });
    mocks.getAccessToken.mockResolvedValue(null);
  });

  it("rejects an unbound request before reading provider cookies", async () => {
    const response = await GET(new Request("https://axis.test/api/widgets/training"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "SUBJECT_CHANGED" });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("passes only the server-authenticated user id to the provider helper", async () => {
    const response = await GET(new Request("https://axis.test/api/widgets/training", {
      headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subject },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(mocks.getAccessToken).toHaveBeenCalledWith(userId);
  });
});
