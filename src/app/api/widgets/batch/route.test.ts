import { beforeEach, describe, expect, it, vi } from "vitest";

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
    source: { provider: "open-meteo", endpoint: "/api/widgets/weather", cacheKey: "weather", requiresAuth: false, requiresLocation: true },
    freshness: { staleAfterSeconds: 60 },
  } : undefined,
}));

import { POST } from "./route";

describe("widget batch internal dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) },
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn(() => ({ in: vi.fn().mockResolvedValue({ data: [], error: null }) })),
      })),
    });
    mocks.invokeWidgetEndpoint.mockResolvedValue(new Response(JSON.stringify({ value: "70°F", hint: "Clear" }), { status: 200 }));
  });

  it("does not derive a self-fetch target or credentials from an adversarial Host header", async () => {
    const response = await POST(new Request("https://attacker.invalid/api/widgets/batch", {
      method: "POST",
      headers: { host: "attacker.invalid", cookie: "session=must-not-forward" },
      body: JSON.stringify({ widgetIds: ["weather"], location: { lat: 1, lon: 2, name: "Test" } }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.invokeWidgetEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/api/widgets/weather" }),
      { lat: 1, lon: 2, name: "Test" },
    );
    expect(JSON.stringify(mocks.invokeWidgetEndpoint.mock.calls)).not.toContain("attacker.invalid");
    expect(JSON.stringify(mocks.invokeWidgetEndpoint.mock.calls)).not.toContain("must-not-forward");
  });
});
