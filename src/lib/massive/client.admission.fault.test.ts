import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  providerFetch: vi.fn(),
}));

vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    providerGlobal: {
      name: "massive-provider",
      limit: 4,
      window: "1 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));
vi.mock("@/lib/env", () => ({
  getPolygonApiKeyEnv: () => "test-polygon-key",
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  timedProviderFetch: (...args: unknown[]) => mocks.providerFetch(...args),
}));

import { massiveRequest } from "./client";

describe("Massive provider-global admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MASSIVE_ADMISSION_PER_MINUTE;
  });

  it("fails closed before provider I/O when distributed admission is unavailable", async () => {
    mocks.admit.mockResolvedValue({
      kind: "unavailable",
      reason: "backend",
    });

    await expect(massiveRequest("/v2/test")).rejects.toMatchObject({
      message: "MASSIVE_ADMISSION_UNAVAILABLE",
      status: 503,
    });
    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });

  it("returns a real provider-global exhaustion signal with retry metadata", async () => {
    mocks.admit.mockResolvedValue({
      kind: "limited",
      retryAfterSeconds: 37,
    });

    await expect(massiveRequest("/v2/test")).rejects.toMatchObject({
      message: "MASSIVE_ADMISSION_LIMITED",
      status: 429,
      retryAfterSeconds: 37,
    });
    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });

  it("uses one server-owned global subject rather than request-controlled identity", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mocks.providerFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(massiveRequest<{ ok: boolean }>("/v2/test")).resolves.toEqual({
      ok: true,
    });
    expect(mocks.admit).toHaveBeenCalledWith(
      "massive-provider-global",
      expect.objectContaining({
        name: "massive-provider",
        protected: true,
      }),
    );
    expect(mocks.providerFetch).toHaveBeenCalledOnce();
    expect(mocks.providerFetch).toHaveBeenCalledWith(
      expect.not.stringContaining("test-polygon-key"),
      expect.objectContaining({
        headers: {
          Authorization: "Bearer test-polygon-key",
        },
      }),
      expect.objectContaining({
        retry: expect.objectContaining({ maxAttempts: 1 }),
      }),
    );
    const [capturedUrl] = mocks.providerFetch.mock.calls[0] as [string];
    expect(capturedUrl).not.toMatch(/api_?key|access_token|authorization/i);
  });

  it("rejects any attempt to put credential-shaped data back in the query", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });

    await expect(
      massiveRequest("/v2/test", { apiKey: "query-secret" }),
    ).rejects.toThrow("MASSIVE_RESERVED_QUERY_PARAMETER");

    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });

  it("rejects a credential query already embedded in the supplied path", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });

    await expect(
      massiveRequest("/v2/test?apiKey=path-secret"),
    ).rejects.toThrow("MASSIVE_INVALID_PATH");

    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });
});
