import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getBrokerageCreds: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("../_lib", () => ({ getBrokerageCreds: mocks.getBrokerageCreds }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

import { GET } from "./route";

function client(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"]) chain[method] = vi.fn(() => chain);
  chain.then = (
    resolve: (value: { data: unknown[]; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
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

describe("brokerage connection authority status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBrokerageCreds.mockReturnValue({ apiKey: "configured" });
  });

  it("requires reconnect for linked legacy Public rows", async () => {
    mocks.createClient.mockResolvedValue(client([{
      institution: "Public",
      status: "linked",
      updated_at: "2026-07-23T12:00:00.000Z",
      authority: "legacy_unknown",
    }]));

    expect(await (await GET()).json()).toMatchObject({
      linked: false,
      reconnectRequired: true,
      connectionCount: 0,
    });
  });
});
