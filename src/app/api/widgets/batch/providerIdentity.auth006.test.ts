import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  invokeWidgetEndpoint: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/widgets/internal", () => ({ invokeWidgetEndpoint: mocks.invokeWidgetEndpoint }));
vi.mock("@/lib/widgets/registry", () => ({
  getWidgetDefinition: (id: string) => id === "weather" ? {
    id,
    label: "Weather",
    statusDefault: "setup_required",
    source: {
      provider: "open-meteo",
      endpoint: "/api/widgets/weather",
      cacheKey: "weather",
      requiresAuth: false,
      requiresLocation: true,
    },
    freshness: { staleAfterSeconds: 60 },
  } : undefined,
}));

import { POST } from "./route";

describe("AUTH-006 widget batch identity boundary", () => {
  const userId = "batch-user";
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
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn(() => ({ in: vi.fn().mockResolvedValue({ data: [], error: null }) })),
      })),
    });
    mocks.invokeWidgetEndpoint.mockResolvedValue(new Response(JSON.stringify({
      value: "70°F",
      hint: "Clear",
    })));
  });

  function batchRequest(headers?: HeadersInit) {
    return new Request("https://axis.test/api/widgets/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        widgetIds: ["weather"],
        location: { lat: 1, lon: 2, name: "Test" },
      }),
    });
  }

  it("rejects stale-account requests before parsing or dispatch", async () => {
    const response = await POST(batchRequest());

    expect(response.status).toBe(409);
    expect(mocks.invokeWidgetEndpoint).not.toHaveBeenCalled();
  });

  it("hands the authenticated user id to trusted in-process dispatch", async () => {
    const response = await POST(batchRequest({
      [EXPECTED_PROFILE_SUBJECT_HEADER]: subject,
      host: "attacker.invalid",
      cookie: "provider-token=must-not-forward",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(mocks.invokeWidgetEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/api/widgets/weather" }),
      { lat: 1, lon: 2, name: "Test" },
      userId,
    );
    expect(JSON.stringify(mocks.invokeWidgetEndpoint.mock.calls)).not.toContain("must-not-forward");
  });
});
