import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const mocks = vi.hoisted(() => ({
  training: vi.fn(),
  inert: vi.fn(),
}));

vi.mock("@/app/api/widgets/agenda/route", () => ({ GET: mocks.inert }));
vi.mock("@/app/api/widgets/air-quality/route", () => ({ GET: mocks.inert }));
vi.mock("@/app/api/widgets/daylight/route", () => ({ GET: mocks.inert }));
vi.mock("@/app/api/widgets/markets/route", () => ({ GET: mocks.inert }));
vi.mock("@/app/api/widgets/training/route", () => ({ GET: mocks.training }));
vi.mock("@/app/api/widgets/weather/route", () => ({ GET: mocks.inert }));

import { invokeWidgetEndpoint } from "./internal";

describe("AUTH-006 trusted internal widget dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.training.mockImplementation((request: Request) => new Response(JSON.stringify({
      subject: request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER),
      cookie: request.headers.get("cookie"),
      host: request.headers.get("host"),
      url: request.url,
    })));
  });

  it("constructs only the server-derived subject context for an allowlisted handler", async () => {
    const userId = "batch-user";
    const response = await invokeWidgetEndpoint({
      provider: "strava",
      endpoint: "/api/widgets/training",
      cacheKey: "run",
      requiresAuth: true,
    }, undefined, userId);
    const dispatched = await response.json();

    expect(dispatched).toEqual({
      subject: profileSubjectForUserId(userId),
      cookie: null,
      host: null,
      url: "https://axis.internal/api/widgets/training",
    });
  });

  it("rejects endpoints outside the fixed in-process allowlist", async () => {
    await expect(invokeWidgetEndpoint({
      provider: "strava",
      endpoint: "https://attacker.invalid/api/widgets/training",
      cacheKey: "run",
      requiresAuth: true,
    }, undefined, "batch-user")).rejects.toThrow("WIDGET_ENDPOINT_NOT_ALLOWLISTED");
    expect(mocks.training).not.toHaveBeenCalled();
  });
});
