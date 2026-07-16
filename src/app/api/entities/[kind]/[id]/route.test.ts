import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolve: vi.fn(),
  from: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/entities/server", () => ({ resolveEntity: mocks.resolve }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.capture }));

import { GET } from "./route";

function emptyReferenceQuery() {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) query[method] = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  return query;
}

describe("GET /api/entities/[kind]/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.from.mockImplementation(() => emptyReferenceQuery());
  });

  it("returns the same not-found response for an unresolved owner-scoped entity", async () => {
    mocks.resolve.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", kind: "note" } });
    const response = await GET(
      new NextRequest("http://axis.test/api/entities/note/x"),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns a preview without mutating frecency on hover", async () => {
    mocks.resolve.mockResolvedValue({
      ok: true,
      entity: { ref: { kind: "note", id: NOTE_ID }, title: "Alpha", href: "/notes", meta: [] },
    });
    const response = await GET(
      new NextRequest("http://axis.test/api/entities/note/x"),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ entity: { title: "Alpha" }, outgoing: [], backlinks: [], referencesStatus: "ok" });
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });
});
