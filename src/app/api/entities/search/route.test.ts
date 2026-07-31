import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  search: vi.fn(),
  capture: vi.fn(),
  usageResult: { data: [] as unknown[], error: null as null | { code?: string } },
}));

function usageQuery() {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(mocks.usageResult).then(resolve);
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: vi.fn(() => usageQuery()),
  }),
}));
vi.mock("@/lib/entities/server", () => ({ searchEntityCandidates: mocks.search }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.capture }));

import { GET } from "./route";

describe("GET /api/entities/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.usageResult = { data: [], error: null };
    mocks.search.mockResolvedValue({ candidates: [], unavailable: [] });
  });

  it("requires authentication", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await GET(new NextRequest("http://axis.test/api/entities/search?q=alpha"));
    expect(response.status).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects invalid filters before querying entity sources", async () => {
    const response = await GET(new NextRequest("http://axis.test/api/entities/search?q=a&types=unknown"));
    expect(response.status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("returns normalized ranked results with an inspectable score", async () => {
    mocks.search.mockResolvedValue({
      candidates: [{
        ref: { kind: "note", id: NOTE_ID },
        title: "Alpha",
        href: "/notes",
        updatedAt: new Date().toISOString(),
        meta: [],
      }],
      unavailable: [],
    });
    mocks.usageResult = {
      data: [{
        entity_kind: "note",
        entity_id: NOTE_ID,
        direct_open_count: 1,
        search_select_count: 2,
        command_count: 0,
        link_count: 0,
        last_used_at: new Date().toISOString(),
        last_action: "search",
      }],
      error: null,
    };
    const response = await GET(new NextRequest("http://axis.test/api/entities/search?q=alpha&types=note"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results[0]).toMatchObject({
      ref: { kind: "note", id: NOTE_ID },
      ranking: { text: 100 },
    });
    expect(body.results[0].ranking.reasons).toContain("Opened 3 times");
    expect(body.partial).toBe(false);
  });

  it("makes source failures visible without logging the private query", async () => {
    mocks.search.mockResolvedValue({
      candidates: [],
      unavailable: [{ code: "UNAVAILABLE", kind: "note", operation: "search", message: "unavailable", providerCode: "57014" }],
    });
    const privateQuery = "private research phrase";
    const response = await GET(new NextRequest(`http://axis.test/api/entities/search?q=${encodeURIComponent(privateQuery)}&types=note`));
    const body = await response.json();
    expect(body.partial).toBe(true);
    expect(body.sources).toEqual([
      { kind: "note", status: "unavailable", count: 0, code: "SOURCE_UNAVAILABLE" },
      { kind: "usage", status: "ok", count: 0 },
    ]);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        area: "workspace",
        operation: "search",
        code: "UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(privateQuery);
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("57014");
  });

  it("exposes normalized usage-source failure without capturing the raw database code", async () => {
    mocks.search.mockResolvedValue({
      candidates: [{
        ref: { kind: "note", id: NOTE_ID },
        title: "Alpha",
        href: "/notes",
        updatedAt: new Date().toISOString(),
        meta: [],
      }],
      unavailable: [],
    });
    mocks.usageResult = { data: [], error: { code: "57014" } };
    const response = await GET(
      new NextRequest("http://axis.test/api/entities/search?q=alpha&types=note"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.sources).toEqual([
      { kind: "note", status: "ok", count: 1 },
      { kind: "usage", status: "unavailable", count: 0, code: "USAGE_UNAVAILABLE" },
    ]);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        area: "workspace",
        operation: "usage",
        code: "USAGE_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("57014");
  });
});
