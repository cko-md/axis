import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getPlaidCreds: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("../_lib", () => ({ getPlaidCreds: mocks.getPlaidCreds }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.captureRouteError }));

import { GET } from "./route";

function client(rows: unknown[], error: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"]) chain[method] = vi.fn(() => chain);
  chain.then = (
    resolve: (value: { data: unknown[]; error: unknown }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error }).then(resolve, reject);
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "user-1" } },
        error: null,
      })),
    },
    from: vi.fn(() => chain),
  };
}

describe("Plaid connection authority status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlaidCreds.mockReturnValue({ env: "sandbox" });
  });

  it("requires reconnect for a linked legacy row instead of treating it as provider-linked", async () => {
    mocks.createClient.mockResolvedValue(client([{
      id: "connection-1",
      institution: "Bank",
      status: "linked",
      updated_at: "2026-07-23T12:00:00.000Z",
      authority: "legacy_unknown",
    }]));

    const response = await GET();

    expect(await response.json()).toMatchObject({
      linked: false,
      reconnectRequired: true,
      connectionCount: 0,
      recoveryConnections: [{ id: "connection-1" }],
    });
  });

  it("reports a verified linked row as current", async () => {
    mocks.createClient.mockResolvedValue(client([{
      id: "connection-1",
      institution: "Bank",
      status: "linked",
      updated_at: "2026-07-23T12:00:00.000Z",
      authority: "provider_verified",
    }]));

    expect(await (await GET()).json()).toMatchObject({
      linked: true,
      reconnectRequired: false,
      connectionCount: 1,
    });
  });

  it("returns unavailable rather than a false disconnected state on database failure", async () => {
    mocks.createClient.mockResolvedValue(client([], new Error("database unavailable")));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "STATUS_UNAVAILABLE",
      message: "Could not read Plaid connection status.",
    });
  });
});
